"""Custom Harbor agent: runs real Pi + Factory headless inside the task container.

Part of the Factory orchestration benchmark
(docs/factory/bombsite-benchmark-plan.md, Gates 5c/5d).

Subclasses Harbor's installed Pi agent so nvm/node/@earendil-works/pi-coding-agent
installation stays Harbor's job. Adds two things on top: Factory itself (an
on-host bundle of this repo's built dist/ plus its only third-party runtime dep)
and the scripted interview answers, which are deliberately placed OUTSIDE /app so
the agent under test cannot read what it is scored against.

Usage:

    PYTHONPATH=harbor/agents harbor run -p harbor/tasks/bombsite-01-ui-shell \
        --agent factory_pi:FactoryPiAgent \
        -m commandcode/deepseek/deepseek-v4-flash \
        --ak interview_answers_path=harbor/tasks/bombsite-01-ui-shell/interview.json
"""

from __future__ import annotations

import json
import os
import shlex
import shutil
import tempfile
from pathlib import Path, PurePosixPath
from typing import Any, override

from harbor.agents.installed.pi import Pi
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

# Repo root, derived from this file so the agent works from any host cwd.
_REPO_ROOT = Path(__file__).resolve().parents[2]

# Where Factory and the scripted answers live inside the container. /opt/factory
# and /task are outside /app: the agent's workspace must not contain the rubric
# or the answers it is expected to give.
_FACTORY_DIR = PurePosixPath("/opt/factory")
_TASK_DIR = PurePosixPath("/task")

# Pi config injected for the trial. Kept out of /app and out of any user's home
# so it works for whichever user the environment runs as.
_PI_CONFIG_DIR = PurePosixPath("/tmp/harbor-factory-pi")

# Bundle-relative entry to run. Running it from the bundled @factory/executor-pi
# copy keeps its sibling dist files resolvable; a standalone copy of the entry
# file does not (verified in-container: ERR_MODULE_NOT_FOUND ./executor.js).
_HARNESS_ENTRY = "node_modules/@factory/executor-pi/dist/runtime-harness.js"

# Packages the headless harness needs at runtime. pi-factory declares
# @earendil-works/pi-coding-agent as peer+dev only, so the SDK is resolved from
# Harbor's global install; yaml is the one real runtime dependency.
_FACTORY_PACKAGES = {
    "@factory/core": "packages/core",
    "@factory/schemas": "packages/schemas",
    "@factory/executor-pi": "packages/executors/pi",
}

# Only this provider is copied into the container. The host's full
# ~/.pi/agent/npm/node_modules also carries pi-goal-list-loop-audit, whose
# goal-continuation orchestrator would interfere with the trial under test.
_COMMANDCODE_PACKAGE = "pi-commandcode-provider"


class FactoryPiAgent(Pi):
    """Pi + Factory, driven without a human."""

    @staticmethod
    @override
    def name() -> str:
        return "factory-pi"

    def __init__(
        self,
        *args: Any,
        interview_answers_path: str | Path | None = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(*args, **kwargs)
        if not interview_answers_path:
            raise ValueError(
                "FactoryPiAgent requires interview_answers_path so interview stages "
                "are answered from script; pass it with --ak interview_answers_path=...",
            )
        self._interview_answers_path = Path(interview_answers_path).expanduser().resolve()
        if not self._interview_answers_path.is_file():
            raise ValueError(f"interview answers file not found: {self._interview_answers_path}")
        self._bundle_dir: Path | None = None

    @override
    def version(self) -> str:
        return "0.1.0"

    # --------------------------------------------------------------- install

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        # Install Pi only if it is not already present. The nvm + npm install
        # is ~80s of every trial (measured agent_setup); a pre-warmed image
        # (or a reused container) already has pi, so skip the network install.
        check = await self.exec_as_agent(
            environment,
            command="set -euo pipefail; . ~/.nvm/nvm.sh 2>/dev/null || true; command -v pi >/dev/null 2>&1 && pi --version >/dev/null 2>&1; echo $?",
        )
        already_installed = int((check.stdout or "1").strip().splitlines()[-1] or "1") == 0
        if not already_installed:
            await super().install(environment)

        self._bundle_dir = _build_factory_bundle()
        try:
            await environment.upload_dir(self._bundle_dir, str(_FACTORY_DIR))
            await environment.upload_file(
                self._interview_answers_path, str(_TASK_DIR / "interview.json")
            )
        finally:
            shutil.rmtree(self._bundle_dir, ignore_errors=True)
            self._bundle_dir = None

        # pi-factory declares the Pi SDK as a peer dependency, so the bundle
        # carries no copy of it and Node's ESM resolver never searches the
        # global npm root. Link Harbor's global install into the bundle rather
        # than installing a second, possibly divergent copy. Runs as the agent
        # user because that is whose home super().install() installed nvm into.
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; . ~/.nvm/nvm.sh; "
                f"cd {_FACTORY_DIR} && "
                "mkdir -p node_modules/@earendil-works && "
                'ln -sfn "$(npm root -g)/@earendil-works/pi-coding-agent" '
                "node_modules/@earendil-works/pi-coding-agent && "
                "node sdk-link-check.mjs"
            ),
        )
        await self._exec_root(
            environment,
            command=(
                f"test -f {_FACTORY_DIR / _HARNESS_ENTRY} "
                f"&& test -f {_TASK_DIR / 'interview.json'} "
                f"&& test ! -e /app/interview.json"
            ),
        )

        # Pi discovers providers/extensions from its own config dir. openai-codex
        # is a Pi built-in provider (its OAuth token travels in auth.json), so no
        # extension package needs copying here. Write a generated settings.json
        # rather than copying the host's: the host list includes
        # pi-goal-list-loop-audit, whose orchestrator would drive the container's
        # Pi and contaminate the run being measured.
        staging = Path(tempfile.mkdtemp(prefix="factory-pi-config-"))
        pi_dir = _pi_agent_dir()
        try:
            shutil.copy2(pi_dir / "auth.json", staging / "auth.json")
            provider, _, model_id = self.model_name.partition("/")
            (staging / "settings.json").write_text(
                json.dumps(
                    {
                        "defaultProvider": provider,
                        "defaultModel": model_id,
                        "packages": [],
                    },
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
            )
            # Pi only auto-installs a project's packages once the project is
            # trusted, so a container run against /app would otherwise fail to
            # load project resources on the first turn.
            (staging / "trust.json").write_text(
                json.dumps({"/app": True}, indent=2) + "\n",
                encoding="utf-8",
            )
            await environment.upload_dir(staging, str(_PI_CONFIG_DIR))
        finally:
            shutil.rmtree(staging, ignore_errors=True)

        # Credentials are world-readable once copied into the container image
        # layer; tighten them the way Harbor's own Pi agent does.
        await self.exec_as_agent(
            environment,
            command=(
                f"chmod 700 {_PI_CONFIG_DIR} && "
                f"chmod 600 {_PI_CONFIG_DIR}/auth.json"
            ),
        )

        await self._exec_root(
            environment,
            command=(
                f"test -f {_FACTORY_DIR / _HARNESS_ENTRY} "
                f"&& test -f {_TASK_DIR / 'interview.json'} "
                f"&& test ! -e /app/interview.json"
            ),
        )

    async def _exec_root(
        self,
        environment: BaseEnvironment,
        command: str,
        env: dict[str, str] | None = None,
    ) -> Any:
        """Run as root, matching how upload_dir/upload_file land files (docker cp
        writes as root, so a non-root exec user could not read them)."""
        return await self._exec(environment, command, user="root", env=env)

    # ------------------------------------------------------------------- run

    @override
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        if not self.model_name or "/" not in self.model_name:
            raise ValueError(
                "FactoryPiAgent needs -m provider/model so every Factory role "
                "routes to a model with a provider (a providerless role model "
                "raises ModelProviderResolutionError in the SDK factory).",
            )

        # Factory writes into /app and the verifier scores whatever it leaves
        # there, so the workspace itself is the output of this run.
        await environment.exec(
            command="git config --global --add safe.directory /app",
            user="root",
        )

        command = (
            ". ~/.nvm/nvm.sh; "
            f"cd {shlex.quote(str(_FACTORY_DIR))} && "
            "FACTORY_PI_USE_REAL_SDK=1 "
            f"FACTORY_PI_RUNTIME_CWD=/app "
            f"FACTORY_PI_MODEL={shlex.quote(self.model_name)} "
            f"FACTORY_PI_DECISIONS_FILE={_TASK_DIR / 'interview.json'} "
            f"FACTORY_PI_RUNTIME_GOAL={shlex.quote(instruction)} "
            f"node {shlex.quote(str(_FACTORY_DIR / _HARNESS_ENTRY))} "
            "2>&1 | stdbuf -oL tee /logs/agent/factory-pi.txt"
        )
        # Mirror Harbor's own Pi.run(): execute as the environment's default agent
        # user, which is the user whose home super().install() put nvm in.
        await self.exec_as_agent(
            environment,
            command=command,
            env={
                # The provider checks this before any auth file (converters.ts:110),
                # so no credential file has to exist inside the container. Passed
                # per-exec rather than baked into a file so it never lands in /app
                # where the agent under test could read it.
                "COMMANDCODE_API_KEY": _commandcode_api_key(),
                # User-agnostic Pi config location, same approach Harbor's Pi agent
                # uses for its own custom models.json.
                "PI_CODING_AGENT_DIR": str(_PI_CONFIG_DIR),
            },
        )


# ------------------------------------------------------------- host-side prep


def _pi_agent_dir() -> Path:
    configured = os.environ.get("PI_CODING_AGENT_DIR")
    root = Path(configured).expanduser() if configured else Path.home() / ".pi" / "agent"
    if not (root / "auth.json").is_file():
        raise ValueError(
            f"No Pi auth.json under {root}; FactoryPiAgent needs Pi credentials "
            "on the host to inject into the trial container.",
        )
    return root


def _commandcode_api_key() -> str:
    auth = json.loads((_pi_agent_dir() / "auth.json").read_text(encoding="utf-8"))
    entry = auth.get("commandcode")
    key = entry.get("key") if isinstance(entry, dict) else None
    if not key:
        raise ValueError(
            "No commandcode api key in auth.json; the trial cannot reach a model "
            "without it. Refusing to run a trial that cannot spend tokens.",
        )
    return str(key)


def _build_factory_bundle() -> Path:
    """Assemble a self-contained Factory install from this repo's build output.

    Flat node_modules of real directories (not workspace symlinks) so nothing in
    the container has to resolve "@factory/core": "0.1.0" against the registry.
    """
    dist = _REPO_ROOT / "packages" / "core" / "dist"
    if not dist.is_dir():
        raise ValueError(f"No build output at {dist}; run `npm run build` first.")

    bundle = Path(tempfile.mkdtemp(prefix="factory-bundle-"))
    modules = bundle / "node_modules"
    modules.mkdir()
    for package_name, source in _FACTORY_PACKAGES.items():
        package_root = _REPO_ROOT / source
        if not (package_root / "dist").is_dir():
            raise ValueError(f"{package_name} has no dist/; run `npm run build` first.")
        target = modules / package_name
        target.mkdir(parents=True)
        shutil.copy2(package_root / "package.json", target / "package.json")
        shutil.copytree(package_root / "dist", target / "dist")

    yaml = _REPO_ROOT / "node_modules" / "yaml"
    if not yaml.is_dir():
        raise ValueError("node_modules/yaml is missing; run `npm install` first.")
    shutil.copytree(yaml, modules / "yaml")

    entry_target = bundle / PurePosixPath(_HARNESS_ENTRY)
    if not entry_target.is_file():
        raise ValueError(f"harness entry missing from bundle: {entry_target}")

    # Written here rather than inlined in a shell command so the container runs
    # the same bytes every time, and so a misbuilt bundle fails at install
    # before any model tokens are spent. This loads the exact harness path that
    # will be executed, which is what caught the missing sibling imports.
    (bundle / "sdk-link-check.mjs").write_text(
        "const sdk = await import('@earendil-works/pi-coding-agent');\n"
        "if (typeof sdk.createAgentSession !== 'function') {\n"
        "  console.error('Pi SDK resolved but has no createAgentSession export');\n"
        "  process.exit(3);\n"
        "}\n"
        "const factory = await import('@factory/executor-pi');\n"
        "if (typeof factory.PiAgentExecutor !== 'function') {\n"
        "  console.error('@factory/executor-pi has no PiAgentExecutor export');\n"
        "  process.exit(4);\n"
        "}\n"
        f"await import('./{PurePosixPath(_HARNESS_ENTRY).as_posix()}');\n"
        "console.log('factory bundle resolves Pi SDK, executor, and harness');\n",
        encoding="utf-8",
    )
    return bundle
