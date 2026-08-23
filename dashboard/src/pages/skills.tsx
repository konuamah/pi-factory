import { useEffect, useState } from 'preact/hooks';
import { api, type SkillInfo } from '../api/client';

export function Skills() {
  const [skills, setSkills] = useState<SkillInfo[]>([]);

  useEffect(() => {
    api.skills().then(setSkills).catch(() => setSkills([]));
  }, []);

  return (
    <>
      <h1>Skills</h1>
      <table>
        <thead>
          <tr><th>Skill</th><th>Version</th><th>Capabilities</th><th>Stages</th></tr>
        </thead>
        <tbody>
          {skills.map((skill) => (
            <tr key={skill.id}>
              <td><strong>{skill.id}</strong><div className="muted">{skill.description}</div></td>
              <td>{skill.version}</td>
              <td>{(skill.capabilities ?? []).join(', ') || '—'}</td>
              <td>{(skill.stages ?? []).join(', ') || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}