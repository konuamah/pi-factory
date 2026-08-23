import { useState } from 'preact/hooks';
import { Overview } from './pages/overview';
import { Runs } from './pages/runs';
import { RunDetail } from './pages/run-detail';
import { Constitution } from './pages/constitution';
import { Skills } from './pages/skills';
import { System } from './pages/system';

export type Route =
  | { name: 'overview' }
  | { name: 'runs' }
  | { name: 'run'; runId: string }
  | { name: 'constitution' }
  | { name: 'skills' }
  | { name: 'system' };

export function App() {
  const [route, setRoute] = useState<Route>({ name: 'overview' });

  const nav = [
    { label: 'Overview', go: () => setRoute({ name: 'overview' }) },
    { label: 'Runs', go: () => setRoute({ name: 'runs' }) },
    { label: 'Constitution', go: () => setRoute({ name: 'constitution' }) },
    { label: 'Skills', go: () => setRoute({ name: 'skills' }) },
    { label: 'System', go: () => setRoute({ name: 'system' }) },
  ];

  return (
    <div className="factory-dashboard container-fluid">
      <aside className="sidebar">
        <div className="brand">Factory</div>
        <nav>
          {nav.map((item) => (
            <a href="#" onClick={(e) => { e.preventDefault(); item.go(); }} key={item.label} className={route.name === item.label.toLowerCase().split(' ')[0] ? 'active' : ''}>
              {item.label}
            </a>
          ))}
        </nav>
      </aside>
      <main className="content">
        <pageSwitch route={route} goToRun={(runId) => setRoute({ name: 'run', runId })} goBack={() => setRoute({ name: 'runs' })} />
      </main>
    </div>
  );
}

function pageSwitch({ route, goToRun, goBack }: { route: Route; goToRun: (runId: string) => void; goBack: () => void }) {
  switch (route.name) {
    case 'overview':
      return <Overview goToRun={goToRun} />;
    case 'runs':
      return <Runs goToRun={goToRun} />;
    case 'run':
      return <RunDetail runId={route.runId} goBack={goBack} />;
    case 'constitution':
      return <Constitution />;
    case 'skills':
      return <Skills />;
    case 'system':
      return <System />;
  }
}