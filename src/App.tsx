import { useEffect, useMemo, useState, type ComponentType } from 'react'
import {
  Activity,
  AlertTriangle,
  AppWindow,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Bot,
  Boxes,
  Braces,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clipboard,
  Cloud,
  Code2,
  Database,
  ExternalLink,
  Eye,
  FileKey,
  Fingerprint,
  Gauge,
  Globe2,
  Hexagon,
  KeyRound,
  Laptop,
  Layers3,
  Link2,
  ListFilter,
  LockKeyhole,
  Menu,
  Network,
  Plus,
  Radar,
  Radio,
  RefreshCw,
  Search,
  Server,
  Settings2,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  UserRoundCog,
  UsersRound,
  Waypoints,
  X,
  Zap,
  type LucideProps,
} from 'lucide-react'
import { apiGet, apiPatch, apiPost } from './api'
import {
  blueprints,
  fallbackDeployments,
  fallbackDomains,
  fallbackIncidents,
  fallbackIntegrations,
  fallbackSensors,
  fallbackSummary,
} from './data'
import type { Blueprint, BlueprintId, Deployment, Domain, Incident, Integration, PageId, Sensor, SensorCommand, Summary } from './types'

type IconType = ComponentType<LucideProps>

const blueprintIcons: Record<BlueprintId, IconType> = {
  'threat-intelligence': Radar,
  'active-directory': UsersRound,
  cloud: Cloud,
  endpoint: Laptop,
  mitm: Link2,
  internal: Server,
  'zero-trust': ShieldCheck,
  'ai-infrastructure': Bot,
}

const navItems: { id: PageId; label: string; icon: IconType; count?: number }[] = [
  { id: 'overview', label: 'Command center', icon: Gauge },
  { id: 'mesh', label: 'Deception mesh', icon: Hexagon },
  { id: 'incidents', label: 'Detections', icon: ShieldAlert, count: 2 },
  { id: 'surfaces', label: 'Protected surfaces', icon: Layers3 },
  { id: 'integrations', label: 'Integrations', icon: Waypoints },
  { id: 'system', label: 'Platform & API', icon: Settings2 },
]

const titleMap: Record<PageId, { title: string; subtitle: string }> = {
  overview: { title: 'Command center', subtitle: 'Live deception posture across your attack surface' },
  mesh: { title: 'Deception mesh', subtitle: 'Design, deploy, and tune every deception asset' },
  incidents: { title: 'Detections', subtitle: 'High-confidence attacker interactions with zero correlation delay' },
  surfaces: { title: 'Protected surfaces', subtitle: 'Identity domains, projection sensors, endpoints, and cloud accounts' },
  integrations: { title: 'Security integrations', subtitle: 'Automate containment through your existing SOC stack' },
  system: { title: 'Platform & API', subtitle: 'Control plane health, access, and developer interfaces' },
}

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ')
}

function StatusDot({ tone = 'healthy' }: { tone?: string }) {
  return <span className={cx('status-dot', `status-dot--${tone}`)} aria-hidden="true" />
}

function StatusPill({ status }: { status: string }) {
  const label = status.replace('-', ' ')
  return <span className={cx('status-pill', `status-pill--${status}`)}><StatusDot tone={status} />{label}</span>
}

function MetricCard({ icon: Icon, label, value, detail, tone = 'violet', trend }: { icon: IconType; label: string; value: string | number; detail: string; tone?: string; trend?: string }) {
  return (
    <article className="metric-card">
      <div className={cx('metric-card__icon', `tone-${tone}`)}><Icon size={18} strokeWidth={1.8} /></div>
      <div className="metric-card__copy">
        <span className="eyebrow">{label}</span>
        <strong>{value}</strong>
        <small>{detail}</small>
      </div>
      {trend && <span className="metric-card__trend"><ArrowUpRight size={13} />{trend}</span>}
    </article>
  )
}

function CoverageRing({ value }: { value: number }) {
  return (
    <div className="coverage-ring" style={{ '--coverage': `${value * 3.6}deg` } as React.CSSProperties}>
      <div><strong>{value}%</strong><span>covered</span></div>
    </div>
  )
}

function SignalChart() {
  return (
    <div className="signal-chart" aria-label="Deception interactions during the last 24 hours">
      <svg viewBox="0 0 650 180" preserveAspectRatio="none" role="img">
        <defs>
          <linearGradient id="areaGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#8b7bff" stopOpacity="0.34" />
            <stop offset="100%" stopColor="#8b7bff" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="lineGradient" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#5f58e8" />
            <stop offset="100%" stopColor="#bb78ff" />
          </linearGradient>
        </defs>
        {[35, 75, 115, 155].map((y) => <line key={y} x1="0" x2="650" y1={y} y2={y} className="chart-grid" />)}
        <path className="chart-area" d="M0 146 C34 144,40 130,78 135 S126 118,156 125 S205 108,235 114 S270 76,303 91 S346 120,375 102 S412 94,441 101 S480 60,512 69 S548 36,582 51 S622 36,650 29 L650 180 L0 180 Z" />
        <path className="chart-line" d="M0 146 C34 144,40 130,78 135 S126 118,156 125 S205 108,235 114 S270 76,303 91 S346 120,375 102 S412 94,441 101 S480 60,512 69 S548 36,582 51 S622 36,650 29" />
        <circle cx="512" cy="69" r="5" className="chart-point" />
        <circle cx="650" cy="29" r="5" className="chart-point" />
      </svg>
      <div className="chart-labels"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>Now</span></div>
    </div>
  )
}

function AttackPath() {
  const stages = [
    { icon: Search, label: 'Discovery', detail: 'Share scan', active: true },
    { icon: FileKey, label: 'Credential', detail: 'Honey secret', active: true },
    { icon: Network, label: 'Lateral move', detail: 'SMB login', active: true },
    { icon: ShieldCheck, label: 'Contained', detail: 'EDR isolate', active: false },
  ]
  return (
    <div className="attack-path">
      {stages.map(({ icon: Icon, label, detail, active }, index) => (
        <div className="attack-path__unit" key={label}>
          <div className={cx('attack-node', active && 'attack-node--active')}><Icon size={17} /></div>
          <strong>{label}</strong>
          <span>{detail}</span>
          {index < stages.length - 1 && <div className="attack-connector"><span /></div>}
        </div>
      ))}
    </div>
  )
}

function IncidentRow({ incident, onSelect }: { incident: Incident; onSelect: () => void }) {
  return (
    <button className="incident-row" onClick={onSelect}>
      <div className={cx('severity-mark', `severity-mark--${incident.severity}`)} />
      <div className="incident-row__main">
        <div><strong>{incident.title}</strong><span className={cx('severity-label', `severity-label--${incident.severity}`)}>{incident.severity}</span></div>
        <small>{incident.id} · {incident.source} → {incident.target}</small>
      </div>
      <div className="incident-row__technique"><span>MITRE</span><strong>{incident.technique}</strong></div>
      <div className="confidence"><strong>{incident.confidence}%</strong><span>confidence</span></div>
      <StatusPill status={incident.status} />
      <time>{incident.age}</time>
      <ChevronRight size={17} />
    </button>
  )
}

function OverviewPage({ summary, incidents, sensors, onDeploy, onIncident, onNavigate }: { summary: Summary; incidents: Incident[]; sensors: Sensor[]; onDeploy: () => void; onIncident: (incident: Incident) => void; onNavigate: (page: PageId) => void }) {
  return (
    <>
      <section className="hero-panel">
        <div className="hero-panel__copy">
          <div className="live-label"><span /> AI-native deception mesh active</div>
          <h2>Make every attack path<br /><em>untrustworthy.</em></h2>
          <p>Detect human and autonomous attackers the moment they touch something that should never be touched.</p>
          <div className="hero-actions">
            <button className="button button--primary" onClick={onDeploy}><Plus size={17} />Deploy deception</button>
            <button className="button button--ghost" onClick={() => onNavigate('mesh')}>Explore mesh <ArrowRight size={16} /></button>
          </div>
        </div>
        <div className="hero-visual" aria-hidden="true">
          <div className="orbital orbital--one" />
          <div className="orbital orbital--two" />
          <div className="orbital orbital--three" />
          <div className="core-node"><Hexagon size={28} fill="currentColor" /></div>
          {[Cloud, Server, KeyRound, Bot, Database].map((Icon, index) => <div className={`orbit-node orbit-node--${index + 1}`} key={index}><Icon size={17} /></div>)}
          <div className="hero-visual__caption"><span><StatusDot /> 93 decoys live</span><strong>4 attack surfaces</strong></div>
        </div>
      </section>

      <section className="metrics-grid">
        <MetricCard icon={Hexagon} label="Deception assets" value={summary.protectedAssets} detail="Across 8 decoy classes" tone="violet" trend="12%" />
        <MetricCard icon={ShieldAlert} label="Active detections" value={summary.activeDetections} detail="2 require analyst action" tone="red" />
        <MetricCard icon={Radio} label="Projection sensors" value={`${summary.sensorsOnline}/${summary.totalSensors}`} detail="All regions reporting" tone="teal" />
        <MetricCard icon={Zap} label="Mean time to detect" value={summary.meanTimeToDetect} detail="From first deception touch" tone="amber" trend="8s" />
      </section>

      <section className="dashboard-grid">
        <article className="panel signal-panel">
          <header className="panel__header">
            <div><span className="eyebrow">Signal velocity</span><h3>Attacker interactions</h3></div>
            <div className="legend"><span><i className="legend__dot legend__dot--violet" /> Deception touches</span><button className="text-select">Last 24 hours <ChevronDown size={14} /></button></div>
          </header>
          <div className="chart-kpi"><strong>37</strong><span><ArrowUpRight size={13} /> 18% from yesterday</span></div>
          <SignalChart />
        </article>

        <article className="panel coverage-panel">
          <header className="panel__header"><div><span className="eyebrow">Exposure coverage</span><h3>Deception posture</h3></div><button className="icon-button"><ExternalLink size={16} /></button></header>
          <div className="coverage-layout">
            <CoverageRing value={summary.coverage} />
            <div className="coverage-list">
              <div><span><i className="tone-dot tone-dot--teal" /> Identity</span><strong>94%</strong></div>
              <div><span><i className="tone-dot tone-dot--violet" /> Cloud</span><strong>89%</strong></div>
              <div><span><i className="tone-dot tone-dot--amber" /> Endpoints</span><strong>81%</strong></div>
              <div><span><i className="tone-dot tone-dot--blue" /> AI stack</span><strong>76%</strong></div>
            </div>
          </div>
          <button className="coverage-action" onClick={() => onNavigate('mesh')}><Sparkles size={15} /> AI found 6 coverage opportunities <ChevronRight size={15} /></button>
        </article>

        <article className="panel detections-panel">
          <header className="panel__header"><div><span className="eyebrow">Immediate action</span><h3>Latest detections</h3></div><button className="link-button" onClick={() => onNavigate('incidents')}>View all <ArrowRight size={14} /></button></header>
          <div className="incident-list compact">
            {incidents.slice(0, 3).map((incident) => <IncidentRow key={incident.id} incident={incident} onSelect={() => onIncident(incident)} />)}
          </div>
        </article>

        <article className="panel attack-panel">
          <header className="panel__header"><div><span className="eyebrow">Agentic behavior detected</span><h3>Reconstructed attack path</h3></div><span className="score-badge"><Bot size={14} /> 96% automated</span></header>
          <p>Parallel enumeration speed and sub-second tool switching indicate an LLM-orchestrated intrusion.</p>
          <AttackPath />
        </article>

        <article className="panel sensors-panel">
          <header className="panel__header"><div><span className="eyebrow">Distributed fabric</span><h3>Sensor health</h3></div><button className="link-button" onClick={() => onNavigate('surfaces')}>Manage <ArrowRight size={14} /></button></header>
          <div className="sensor-list">
            {sensors.map((sensor) => (
              <div className="sensor-item" key={sensor.id}>
                <div className="sensor-item__icon"><Radio size={16} /></div>
                <div><strong>{sensor.name}</strong><span>{sensor.address} · {sensor.latency}ms</span></div>
                <div className="health-bar"><span style={{ width: `${sensor.health}%` }} /></div>
                <strong>{sensor.health}%</strong>
              </div>
            ))}
          </div>
        </article>
      </section>
    </>
  )
}

function BlueprintCard({ blueprint, onDeploy }: { blueprint: Blueprint; onDeploy: (id: BlueprintId) => void }) {
  const Icon = blueprintIcons[blueprint.id]
  return (
    <article className="blueprint-card" style={{ '--accent': blueprint.color } as React.CSSProperties}>
      <div className="blueprint-card__top">
        <div className="blueprint-icon"><Icon size={21} /></div>
        <span className="blueprint-signal"><Activity size={13} /> {blueprint.signal}</span>
      </div>
      <span className="eyebrow">{blueprint.eyebrow}</span>
      <h3>{blueprint.name}</h3>
      <p>{blueprint.description}</p>
      <div className="tag-row">{blueprint.assets.slice(0, 3).map((asset) => <span key={asset}>{asset}</span>)}</div>
      <button className="card-action" onClick={() => onDeploy(blueprint.id)}>Configure blueprint <ArrowUpRight size={15} /></button>
    </article>
  )
}

function MeshPage({ deployments, onDeploy, onToken }: { deployments: Deployment[]; onDeploy: (id?: BlueprintId) => void; onToken: () => void }) {
  const [tab, setTab] = useState<'blueprints' | 'deployments' | 'tokens'>('blueprints')
  return (
    <>
      <div className="page-toolbar">
        <div className="segmented-control">
          {(['blueprints', 'deployments', 'tokens'] as const).map((item) => <button className={tab === item ? 'active' : ''} onClick={() => setTab(item)} key={item}>{item === 'tokens' ? 'Canary tokens' : item}</button>)}
        </div>
        <button className="button button--primary" onClick={() => tab === 'tokens' ? onToken() : onDeploy()}><Plus size={16} />{tab === 'tokens' ? 'Generate token' : 'New deployment'}</button>
      </div>

      {tab === 'blueprints' && (
        <>
          <section className="section-intro"><div><span className="eyebrow">Complete attack-surface coverage</span><h2>Choose what you want to make deceptive</h2><p>Every blueprint ships with safe defaults and a fully guided deployment path.</p></div><div className="inline-proof"><ShieldCheck size={18} /><span><strong>Agentless-first</strong>Designed for low operational impact</span></div></section>
          <section className="blueprint-grid">{blueprints.map((blueprint) => <BlueprintCard key={blueprint.id} blueprint={blueprint} onDeploy={onDeploy} />)}</section>
        </>
      )}

      {tab === 'deployments' && (
        <section className="panel table-panel">
          <header className="panel__header"><div><span className="eyebrow">Live fabric</span><h3>{deployments.length} active deployments</h3></div><button className="filter-button"><ListFilter size={15} /> Filter</button></header>
          <div className="data-table">
            <div className="data-table__head"><span>Deployment</span><span>Surface</span><span>Placement</span><span>Decoys</span><span>Signals</span><span>Status</span><span /></div>
            {deployments.map((deployment) => {
              const blueprint = blueprints.find((item) => item.id === deployment.blueprintId)!
              const Icon = blueprintIcons[deployment.blueprintId]
              return <div className="data-table__row" key={deployment.id}>
                <span className="table-primary"><i style={{ color: blueprint.color }}><Icon size={16} /></i><span><strong>{deployment.name}</strong><small>{deployment.id}</small></span></span>
                <span>{blueprint.name}</span><span><strong>{deployment.environment}</strong><small>{deployment.location}</small></span><span>{deployment.decoys}</span><span>{deployment.interactions}</span><span><StatusPill status={deployment.status} /></span><button className="icon-button"><ChevronRight size={16} /></button>
              </div>
            })}
          </div>
        </section>
      )}

      {tab === 'tokens' && (
        <section className="token-layout">
          <article className="token-hero panel">
            <div className="token-illustration"><FileKey size={42} /><span className="pulse-ring pulse-ring--1" /><span className="pulse-ring pulse-ring--2" /></div>
            <span className="eyebrow">Deploy in under 60 seconds</span>
            <h2>Turn everyday artifacts into high-confidence tripwires.</h2>
            <p>Create fake files, credentials, cloud keys, database connections, API secrets, and browser artifacts. Every touch becomes an enriched detection.</p>
            <button className="button button--primary" onClick={onToken}><Plus size={16} /> Generate your first token</button>
          </article>
          <div className="token-types">
            {[
              [FileKey, 'Honey documents', 'Word, Excel, PDF, and archive files'],
              [KeyRound, 'Deceptive credentials', 'Cached logins, SSH keys, and secrets'],
              [Database, 'Fake connections', 'ODBC, database, RDP, and SMB profiles'],
              [Cloud, 'Cloud keys', 'AWS, Azure, and GCP honey credentials'],
              [Code2, 'API & agent secrets', 'Tokens for apps, models, MCP, and tools'],
              [Network, 'Network breadcrumbs', 'Shares, DNS records, and service links'],
            ].map(([Icon, title, detail]) => {
              const TokenIcon = Icon as IconType
              return <article className="token-type" key={title as string}><div><TokenIcon size={19} /></div><span><strong>{title as string}</strong><small>{detail as string}</small></span><ChevronRight size={16} /></article>
            })}
          </div>
        </section>
      )}
    </>
  )
}

function IncidentsPage({ incidents, onSelect }: { incidents: Incident[]; onSelect: (incident: Incident) => void }) {
  const [filter, setFilter] = useState('all')
  const filtered = filter === 'all' ? incidents : incidents.filter((incident) => incident.severity === filter)
  return (
    <>
      <section className="detection-summary">
        <div><span className="severity-orb severity-orb--critical"><AlertTriangle size={17} /></span><span><strong>1</strong><small>Critical</small></span></div>
        <div><span className="severity-orb severity-orb--high"><ShieldAlert size={17} /></span><span><strong>1</strong><small>High</small></span></div>
        <div><span className="severity-orb severity-orb--medium"><Eye size={17} /></span><span><strong>1</strong><small>Needs review</small></span></div>
        <div className="detection-summary__statement"><Bot size={20} /><span><strong>1 agentic sequence identified</strong><small>Behavioral velocity exceeded human interaction thresholds</small></span></div>
      </section>
      <section className="panel incident-panel">
        <header className="incident-toolbar">
          <div className="filter-chips">{['all', 'critical', 'high', 'medium', 'low'].map((item) => <button className={filter === item ? 'active' : ''} onClick={() => setFilter(item)} key={item}>{item}<span>{item === 'all' ? incidents.length : incidents.filter((incident) => incident.severity === item).length}</span></button>)}</div>
          <div className="toolbar-actions"><button className="filter-button"><RefreshCw size={14} /> Refresh</button><button className="filter-button"><ListFilter size={14} /> Filters</button></div>
        </header>
        <div className="incident-list">{filtered.map((incident) => <IncidentRow key={incident.id} incident={incident} onSelect={() => onSelect(incident)} />)}</div>
      </section>
    </>
  )
}

function SurfacesPage({ domains, sensors, deadLetters, onDeploy, onAddSensor, onRetryCommand, onDismissCommand }: { domains: Domain[]; sensors: Sensor[]; deadLetters: SensorCommand[]; onDeploy: (id?: BlueprintId) => void; onAddSensor: () => void; onRetryCommand: (command: SensorCommand) => void; onDismissCommand: (command: SensorCommand) => void }) {
  return (
    <div className="surfaces-grid">
      <section className="panel identity-panel">
        <header className="panel__header"><div><span className="eyebrow">Multi-domain Active Directory</span><h3>Identity protection</h3></div><button className="button button--small" onClick={() => onDeploy('active-directory')}><Plus size={15} /> Add domain</button></header>
        <div className="identity-visual">
          <div className="forest-node"><UsersRound size={22} /><span><strong>corp.global</strong><small>2 child domains</small></span></div>
          <div className="tree-lines" />
          {domains.map((domain) => <div className="domain-card" key={domain.id}><span className="domain-icon"><Fingerprint size={17} /></span><span><strong>{domain.name}</strong><small>{domain.controllers} controllers · {domain.honeyObjects} honey objects</small></span><StatusPill status={domain.status} /></div>)}
        </div>
        <div className="coverage-tags"><span>Kerberoasting</span><span>AS-REP roasting</span><span>DCSync</span><span>Golden SAML</span><span>Recon</span><span>Delegation abuse</span></div>
      </section>

      <section className="panel endpoint-panel">
        <header className="panel__header"><div><span className="eyebrow">Advanced endpoint detection</span><h3>Detection policy</h3></div><span className="score-badge"><ShieldCheck size={14} /> Hardened</span></header>
        <div className="policy-list">
          {[
            [FileKey, 'Ransomware tripwires', 'Honey files across high-value user paths', '2,481 endpoints'],
            [KeyRound, 'Credential access', 'LSASS, vault, SSH, and browser lures', '1,920 endpoints'],
            [TerminalSquare, 'Living off the land', 'Process-aware CLI and admin breadcrumbs', '1,614 endpoints'],
            [Bot, 'Agentic sequence analysis', 'Speed, parallelism, and tool-use fingerprinting', 'All signals'],
          ].map(([Icon, title, detail, count]) => {
            const PolicyIcon = Icon as IconType
            return <div className="policy-item" key={title as string}><span><PolicyIcon size={17} /></span><div><strong>{title as string}</strong><small>{detail as string}</small></div><em>{count as string}</em><div className="toggle active"><i /></div></div>
          })}
        </div>
      </section>

      <section className="panel sensor-panel-wide">
        <header className="panel__header"><div><span className="eyebrow">Agentless projection fabric</span><h3>Deployment sensors</h3></div><button className="button button--small" onClick={onAddSensor}><Plus size={15} /> Add sensor</button></header>
        <div className="sensor-cards">{sensors.map((sensor) => <article key={sensor.id}><div className="sensor-card__top"><span><Radio size={17} /></span><StatusDot tone={sensor.health > 90 ? 'healthy' : 'attention'} /></div><strong>{sensor.name}</strong><small>{sensor.type} · v{sensor.version}</small><div className="sensor-stats"><span><strong>{sensor.health}%</strong> health</span><span><strong>{sensor.latency}ms</strong> latency</span></div><footer><span>{sensor.address}</span><span>{sensor.lastSeen}</span></footer></article>)}</div>
      </section>

      <section className="panel command-recovery-panel">
        <header className="panel__header"><div><span className="eyebrow">Guided recovery</span><h3>Command dead-letter queue</h3></div><span className={cx('recovery-count', deadLetters.length > 0 && 'attention')}>{deadLetters.length}</span></header>
        {deadLetters.length === 0
          ? <div className="recovery-empty"><ShieldCheck size={20} /><span><strong>No commands need attention</strong><small>Exhausted and expired sensor commands appear here with guided recovery actions.</small></span></div>
          : <div className="recovery-list">{deadLetters.map((command) => <article key={command.id}><span className="severity-orb severity-orb--high"><AlertTriangle size={15} /></span><div><strong>{command.type.replaceAll('_', ' ')}</strong><small>{command.sensorId} · {command.attempts}/{command.maxAttempts} attempts · {command.error || command.deadLetterReason}</small></div><button className="button button--small" onClick={() => onRetryCommand(command)}><RefreshCw size={13} /> Retry</button><button className="icon-button" aria-label={`Dismiss ${command.id}`} onClick={() => onDismissCommand(command)}><X size={14} /></button></article>)}</div>}
      </section>
    </div>
  )
}

function IntegrationsPage({ integrations, onToast }: { integrations: Integration[]; onToast: (message: string) => void }) {
  const catalog = [
    ['SIEM', 'Splunk Enterprise Security', 'Stream normalized detection events and attack timelines.', '#70d68a'],
    ['EDR', 'CrowdStrike Falcon', 'Isolate compromised endpoints on verified deception touch.', '#f06f78'],
    ['SOAR', 'Tines', 'Trigger guided investigation and containment stories.', '#8b7bff'],
    ['XDR', 'Microsoft Defender XDR', 'Enrich incidents and request machine isolation.', '#63a8ff'],
    ['SIEM', 'Elastic Security', 'Export ECS-compatible events over HTTPS.', '#f0c05a'],
    ['SOAR', 'Palo Alto Cortex XSOAR', 'Launch playbooks with full deception context.', '#58d1cd'],
  ]
  return (
    <>
      <section className="integration-banner">
        <div><span className="eyebrow">Detection to containment</span><h2>Turn a deception touch into action—automatically.</h2><p>Send enriched signals to SIEM, launch SOAR playbooks, and isolate sources through EDR or XDR.</p></div>
        <div className="integration-flow" aria-hidden="true"><span><Hexagon size={20} /></span><i /><span><Braces size={20} /></span><i /><span><ShieldCheck size={20} /></span></div>
      </section>
      <section className="integration-grid">
        {catalog.map(([category, name, description, color]) => {
          const current = integrations.find((integration) => integration.name === name)
          const initials = name.split(' ').map((word) => word[0]).slice(0, 2).join('')
          return <article className="integration-card" key={name}>
            <div className="integration-card__head"><span className="integration-logo" style={{ '--brand': color } as React.CSSProperties}>{initials}</span><span className="category-label">{category}</span></div>
            <h3>{name}</h3><p>{description}</p>
            <footer>{current?.status === 'connected' ? <span className="connected-label"><CheckCircle2 size={14} /> Connected · {current.lastSync}</span> : <button className="card-action" onClick={() => onToast(`${name} connection wizard opened`)}>Connect <ArrowRight size={14} /></button>}</footer>
          </article>
        })}
      </section>
    </>
  )
}

function SystemPage({ sensors, onToast }: { sensors: Sensor[]; onToast: (message: string) => void }) {
  const curl = `curl -X POST http://localhost:8787/api/v1/tokens \\\n+  -H "Content-Type: application/json" \\\n+  -d '{"name":"Quarterly plan","type":"document"}'`
  return (
    <div className="system-layout">
      <section className="panel platform-health">
        <header className="panel__header"><div><span className="eyebrow">Control plane</span><h3>Platform health</h3></div><StatusPill status="healthy" /></header>
        <div className="health-metrics">
          <div><span><Activity size={17} /> API availability</span><strong>99.99%</strong><small>Last 30 days</small></div>
          <div><span><Zap size={17} /> Event latency</span><strong>184ms</strong><small>p95 ingest to alert</small></div>
          <div><span><Radio size={17} /> Sensor fabric</span><strong>{sensors.length}/{sensors.length}</strong><small>Reporting normally</small></div>
          <div><span><Database size={17} /> Event retention</span><strong>90d</strong><small>Hot searchable data</small></div>
        </div>
      </section>
      <section className="panel api-panel">
        <header className="panel__header"><div><span className="eyebrow">Complete developer interface</span><h3>REST API</h3></div><a className="button button--small" href="/openapi.yaml" target="_blank">OpenAPI spec <ExternalLink size={14} /></a></header>
        <p>Everything available in the GUI is designed around an auditable API surface for automation, Terraform providers, and SOC workflows.</p>
        <div className="code-window"><div><span className="code-dot code-dot--red" /><span className="code-dot code-dot--amber" /><span className="code-dot code-dot--green" /><small>Generate a canary token</small><button onClick={() => { navigator.clipboard?.writeText(curl); onToast('API example copied') }}><Clipboard size={14} /> Copy</button></div><pre>{curl}</pre></div>
        <div className="api-resources">{['Deployments', 'Canary tokens', 'Incidents', 'Sensors', 'Domains', 'Integrations'].map((item) => <span key={item}><Check size={13} /> {item}</span>)}</div>
      </section>
      <section className="panel access-panel">
        <header className="panel__header"><div><span className="eyebrow">Secure by default</span><h3>Access & governance</h3></div><button className="icon-button"><Settings2 size={16} /></button></header>
        <div className="setting-rows">
          <div><span><LockKeyhole size={17} /></span><div><strong>Single sign-on</strong><small>OIDC with enforced MFA</small></div><StatusPill status="healthy" /></div>
          <div><span><UserRoundCog size={17} /></span><div><strong>Role-based access</strong><small>4 roles · 12 active users</small></div><ChevronRight size={16} /></div>
          <div><span><Clipboard size={17} /></span><div><strong>Audit trail</strong><small>Immutable administration events</small></div><ChevronRight size={16} /></div>
          <div><span><KeyRound size={17} /></span><div><strong>API credentials</strong><small>3 service principals</small></div><ChevronRight size={16} /></div>
        </div>
      </section>
    </div>
  )
}

interface DeployForm {
  blueprintId: BlueprintId
  name: string
  environment: string
  location: string
  mode: string
  lureTypes: string[]
  realism: number
  aiAdaptation: boolean
  autoContainment: boolean
}

function DeployWizard({ initialBlueprint, onClose, onComplete }: { initialBlueprint?: BlueprintId; onClose: () => void; onComplete: (deployment: Deployment) => void }) {
  const [step, setStep] = useState(initialBlueprint ? 2 : 1)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState<DeployForm>({
    blueprintId: initialBlueprint || 'active-directory',
    name: '',
    environment: 'Production',
    location: '',
    mode: 'agentless',
    lureTypes: ['Fake credentials', 'Fake files'],
    realism: 82,
    aiAdaptation: true,
    autoContainment: true,
  })
  const blueprint = blueprints.find((item) => item.id === form.blueprintId)!
  const Icon = blueprintIcons[blueprint.id]
  const canContinue = step === 1 || (step === 2 ? form.name.trim() && form.location.trim() : true)

  async function submit() {
    setSubmitting(true)
    setError('')
    try {
      const deployment = await apiPost<Deployment>('deployments', {
        name: form.name,
        blueprintId: form.blueprintId,
        environment: form.environment,
        location: form.location,
        mode: form.mode,
        customizations: { lureTypes: form.lureTypes, realism: form.realism, aiAdaptation: form.aiAdaptation, autoContainment: form.autoContainment },
      })
      onComplete(deployment)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create deployment')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="wizard-modal" role="dialog" aria-modal="true" aria-label="Guided deception deployment">
        <aside className="wizard-rail">
          <div className="brand brand--compact"><span><Hexagon size={17} fill="currentColor" /></span><strong>AID</strong></div>
          <div className="wizard-rail__copy"><span className="eyebrow">Guided deployment</span><h2>Build a deception layer that belongs in your environment.</h2></div>
          <ol>
            {['Select surface', 'Choose placement', 'Customize lures', 'Review & deploy'].map((label, index) => <li className={cx(step === index + 1 && 'active', step > index + 1 && 'complete')} key={label}><span>{step > index + 1 ? <Check size={13} /> : index + 1}</span><div><strong>{label}</strong><small>{['Choose a blueprint', 'Set the scope', 'Shape the illusion', 'Confirm guardrails'][index]}</small></div></li>)}
          </ol>
          <div className="wizard-help"><CircleHelp size={17} /><span><strong>Safe by design</strong>Decoys cannot authenticate to production assets or become pivot points.</span></div>
        </aside>
        <main className="wizard-main">
          <header><div><span>Step {step} of 4</span><strong>{['Choose your deception surface', 'Where should it appear?', 'Make the deception convincing', 'Ready to deploy'][step - 1]}</strong></div><button className="icon-button" onClick={onClose}><X size={18} /></button></header>
          <div className="wizard-content">
            {step === 1 && <div className="wizard-blueprints">{blueprints.map((item) => { const ItemIcon = blueprintIcons[item.id]; return <button className={form.blueprintId === item.id ? 'selected' : ''} key={item.id} onClick={() => setForm({ ...form, blueprintId: item.id })} style={{ '--accent': item.color } as React.CSSProperties}><span><ItemIcon size={18} /></span><div><strong>{item.name}</strong><small>{item.eyebrow}</small></div>{form.blueprintId === item.id && <CheckCircle2 size={17} />}</button> })}</div>}
            {step === 2 && <div className="form-layout"><div className="selected-blueprint" style={{ '--accent': blueprint.color } as React.CSSProperties}><span><Icon size={22} /></span><div><strong>{blueprint.name}</strong><small>{blueprint.description}</small></div><button onClick={() => setStep(1)}>Change</button></div><label><span>Deployment name</span><input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="e.g. Finance identity mesh" autoFocus /></label><div className="form-row"><label><span>Environment</span><select value={form.environment} onChange={(event) => setForm({ ...form, environment: event.target.value })}><option>Production</option><option>Development</option><option>AWS / us-east-1</option><option>Azure / eastus2</option><option>Kubernetes</option><option>Factory edge</option></select></label><label><span>Placement / scope</span><input value={form.location} onChange={(event) => setForm({ ...form, location: event.target.value })} placeholder="corp.east / finance" /></label></div><label><span>Projection mode</span><div className="choice-cards">{[['agentless', 'Agentless', 'Use native APIs and existing sensors'], ['sensor', 'Projection sensor', 'Project decoys into remote segments'], ['package', 'Endpoint package', 'Deploy lightweight breadcrumb bundle']].map(([value, label, detail]) => <button className={form.mode === value ? 'selected' : ''} onClick={() => setForm({ ...form, mode: value })} key={value}><Radio size={17} /><span><strong>{label}</strong><small>{detail}</small></span>{form.mode === value && <Check size={15} />}</button>)}</div></label></div>}
            {step === 3 && <div className="customization-layout"><div><span className="field-label">Deception assets</span><p>Select the lures this deployment can project.</p><div className="check-grid">{['Fake servers', 'Fake services', 'Fake assets', 'Fake files', 'Fake credentials', 'Fake connections'].map((lure) => <button className={form.lureTypes.includes(lure) ? 'selected' : ''} onClick={() => setForm({ ...form, lureTypes: form.lureTypes.includes(lure) ? form.lureTypes.filter((item) => item !== lure) : [...form.lureTypes, lure] })} key={lure}><span>{form.lureTypes.includes(lure) && <Check size={13} />}</span>{lure}</button>)}</div></div><div className="range-field"><div><span className="field-label">Realism profile</span><strong>{form.realism}%</strong></div><input type="range" min="30" max="100" value={form.realism} onChange={(event) => setForm({ ...form, realism: Number(event.target.value) })} /><div><small>Low interaction</small><small>High fidelity</small></div></div><button className={cx('toggle-row', form.aiAdaptation && 'active')} onClick={() => setForm({ ...form, aiAdaptation: !form.aiAdaptation })}><span><Sparkles size={18} /><span><strong>AI-adaptive placement</strong><small>Continuously tune names, attributes, and paths to match the environment.</small></span></span><div className="toggle"><i /></div></button></div>}
            {step === 4 && <div className="review-layout"><div className="review-hero" style={{ '--accent': blueprint.color } as React.CSSProperties}><span><Icon size={24} /></span><div><small>Deploying</small><h3>{form.name}</h3><p>{blueprint.name} · {form.environment} · {form.location}</p></div></div><div className="review-grid"><div><span>Projection</span><strong>{form.mode}</strong></div><div><span>Deception assets</span><strong>{form.lureTypes.length} types</strong></div><div><span>Realism</span><strong>{form.realism}%</strong></div><div><span>AI adaptation</span><strong>{form.aiAdaptation ? 'Enabled' : 'Disabled'}</strong></div></div><button className={cx('toggle-row', form.autoContainment && 'active')} onClick={() => setForm({ ...form, autoContainment: !form.autoContainment })}><span><ShieldCheck size={18} /><span><strong>Automatic containment</strong><small>Allow connected EDR/XDR to isolate a verified source after a critical interaction.</small></span></span><div className="toggle"><i /></div></button><div className="guardrail-note"><Shield size={17} /><span><strong>Guardrails applied</strong>Outbound access is denied, production credentials are never used, and every administrative action is audited.</span></div>{error && <div className="form-error"><AlertTriangle size={15} />{error}</div>}</div>}
          </div>
          <footer><button className="button button--ghost" onClick={() => step === 1 ? onClose() : setStep(step - 1)}>{step === 1 ? 'Cancel' : 'Back'}</button><div><span><ShieldCheck size={14} /> Reversible at any time</span><button className="button button--primary" disabled={!canContinue || submitting} onClick={() => step === 4 ? submit() : setStep(step + 1)}>{submitting ? <><RefreshCw className="spin" size={15} /> Deploying</> : step === 4 ? <><Zap size={16} /> Deploy now</> : <>Continue <ArrowRight size={16} /></>}</button></div></footer>
        </main>
      </section>
    </div>
  )
}

function SensorEnrollmentModal({ onClose, onToast }: { onClose: () => void; onToast: (message: string) => void }) {
  const [name, setName] = useState('Edge projection sensor')
  const [enrollment, setEnrollment] = useState<{ token: string; expiresAt: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const controllerUrl = window.location.port === '4173' ? `${window.location.protocol}//${window.location.hostname}:8787` : window.location.origin
  const runCommand = enrollment ? `docker run --rm --network host -e AID_CONTROLLER_URL=${controllerUrl} -e AID_ENROLLMENT_TOKEN=${enrollment.token} -e "AID_SENSOR_NAME=${name}" -v aidecepticon-sensor-state:/var/lib/aidecepticon aidecepticon-sensor` : ''

  async function generateEnrollment() {
    setLoading(true)
    setError('')
    try {
      setEnrollment(await apiPost<{ token: string; expiresAt: string }>('sensor-enrollment-tokens', { label: name, ttlMinutes: 15 }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to create enrollment token')
    } finally {
      setLoading(false)
    }
  }

  return <div className="modal-backdrop"><section className="simple-modal sensor-enrollment-modal" role="dialog" aria-modal="true" aria-label="Enroll projection sensor"><header><div className="modal-title-icon"><Radio size={20} /></div><div><span className="eyebrow">Projection fabric</span><h2>{enrollment ? 'Enroll your sensor' : 'Add a projection sensor'}</h2></div><button className="icon-button" onClick={onClose}><X size={18} /></button></header>{!enrollment ? <div className="token-form"><p>Create a single-use enrollment token for a sensor in an on-premises, cloud, edge, or isolated network segment.</p><label><span>Sensor name</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. East datacenter" /></label><div className="sensor-security-list"><span><ShieldCheck size={16} /><b>One-time token</b> Expires after 15 minutes</span><span><KeyRound size={16} /><b>Unique identity</b> Per-sensor access and signing keys</span><span><LockKeyhole size={16} /><b>Secure transport</b> HTTPS and optional mTLS</span></div>{error && <div className="form-error"><AlertTriangle size={15} />{error}</div>}<button className="button button--primary full" disabled={!name.trim() || loading} onClick={generateEnrollment}>{loading ? <RefreshCw className="spin" size={16} /> : <Plus size={16} />} Create enrollment</button></div> : <div className="sensor-enrollment"><div className="enrollment-expiry"><StatusDot tone="healthy" /><span><strong>Enrollment ready</strong>Token expires {new Date(enrollment.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div><div className="enrollment-step"><b>1</b><span><strong>Build the sensor image</strong><code>docker build -t aidecepticon-sensor ./sensor</code></span><button onClick={() => { navigator.clipboard?.writeText('docker build -t aidecepticon-sensor ./sensor'); onToast('Build command copied') }}><Clipboard size={14} /></button></div><div className="enrollment-step"><b>2</b><span><strong>Run in the target segment</strong><code>{runCommand}</code></span><button onClick={() => { navigator.clipboard?.writeText(runCommand); onToast('Enrollment command copied') }}><Clipboard size={14} /></button></div><div className="enrollment-step"><b>3</b><span><strong>Return here</strong><small>The sensor appears automatically after its first authenticated heartbeat.</small></span></div><div className="guardrail-note"><Shield size={17} /><span>The token is shown once. The sensor stores its unique credentials with owner-only permissions and verifies every command signature before execution.</span></div><button className="button button--primary full" onClick={onClose}>Done</button></div>}</section></div>
}

function TokenModal({ onClose, onComplete }: { onClose: () => void; onComplete: (message: string) => void }) {
  const [name, setName] = useState('')
  const [type, setType] = useState('document')
  const [destination, setDestination] = useState('Finance endpoints')
  const [created, setCreated] = useState<{ beaconUrl: string; id: string } | null>(null)
  const [loading, setLoading] = useState(false)
  async function generate() {
    setLoading(true)
    try {
      const token = await apiPost<{ beaconUrl: string; id: string }>('tokens', { name, type, destination })
      setCreated(token)
    } catch (cause) {
      onComplete(cause instanceof Error ? cause.message : 'Unable to generate token')
    } finally { setLoading(false) }
  }
  return <div className="modal-backdrop"><section className="simple-modal" role="dialog" aria-modal="true"><header><div className="modal-title-icon"><FileKey size={20} /></div><div><span className="eyebrow">Canary generator</span><h2>{created ? 'Your token is armed' : 'Create a deception token'}</h2></div><button className="icon-button" onClick={onClose}><X size={18} /></button></header>{created ? <div className="token-success"><span className="success-icon"><Check size={24} /></span><p>Any access to this token opens a high-confidence incident with source context.</p><label><span>Beacon URL</span><div className="copy-field"><code>{created.beaconUrl}</code><button onClick={() => { navigator.clipboard?.writeText(created.beaconUrl); onComplete('Beacon URL copied') }}><Clipboard size={15} /></button></div></label><div className="next-steps"><strong>Next steps</strong><span><b>1</b> Embed the URL in your file, credential, or connection artifact.</span><span><b>2</b> Place the artifact through your approved software deployment workflow.</span><span><b>3</b> AIDecepticon watches for the first interaction.</span></div><button className="button button--primary full" onClick={onClose}>Done</button></div> : <div className="token-form"><p>Generate a unique tripwire, then place it using your existing endpoint or cloud tooling.</p><label><span>Token name</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. FY27 board plan" /></label><label><span>Artifact type</span><div className="type-selector">{[['document', FileKey, 'File'], ['credential', KeyRound, 'Credential'], ['connection', Database, 'Connection'], ['cloud-key', Cloud, 'Cloud key'], ['api-key', Code2, 'API key']].map(([value, Icon, label]) => { const TokenIcon = Icon as IconType; return <button className={type === value ? 'selected' : ''} onClick={() => setType(value as string)} key={value as string}><TokenIcon size={17} /><span>{label as string}</span></button> })}</div></label><label><span>Placement group</span><select value={destination} onChange={(event) => setDestination(event.target.value)}><option>Finance endpoints</option><option>Executive endpoints</option><option>Cloud workloads</option><option>AI platform</option><option>Custom placement</option></select></label><div className="guardrail-note"><Shield size={17} /><span>Tokens contain no live production access and cannot be used to pivot.</span></div><button className="button button--primary full" disabled={!name.trim() || loading} onClick={generate}>{loading ? <RefreshCw className="spin" size={16} /> : <Zap size={16} />} Generate & arm token</button></div>}</section></div>
}

function IncidentDrawer({ incident, onClose, onUpdate }: { incident: Incident; onClose: () => void; onUpdate: (incident: Incident) => void }) {
  const [busy, setBusy] = useState(false)
  async function updateStatus(status: string) {
    setBusy(true)
    try { onUpdate(await apiPatch<Incident>(`incidents/${incident.id}`, { status })) } finally { setBusy(false) }
  }
  return <div className="drawer-backdrop" onMouseDown={onClose}><aside className="incident-drawer" onMouseDown={(event) => event.stopPropagation()}><header><div><span className={cx('severity-label', `severity-label--${incident.severity}`)}>{incident.severity}</span><span>{incident.id}</span></div><button className="icon-button" onClick={onClose}><X size={18} /></button></header><div className="drawer-title"><span className={cx('severity-orb', `severity-orb--${incident.severity}`)}><ShieldAlert size={21} /></span><h2>{incident.title}</h2><p>{incident.summary}</p></div><div className="drawer-facts"><div><span>Source</span><strong>{incident.source}</strong></div><div><span>Target</span><strong>{incident.target}</strong></div><div><span>MITRE ATT&CK</span><strong>{incident.technique}</strong></div><div><span>Confidence</span><strong>{incident.confidence}%</strong></div></div><section><span className="eyebrow">Attack sequence</span><div className="timeline">{incident.steps.map((step, index) => <div key={step}><span>{index + 1}</span><div><strong>{step}</strong><small>{index === incident.steps.length - 1 ? 'Current state' : `${Math.max(1, 7 - index * 2)} minutes ago`}</small></div></div>)}</div></section><section><span className="eyebrow">Why this matters</span><div className="insight-card"><Bot size={18} /><span><strong>Agentic behavior confidence: 96%</strong><small>Parallel discovery, uniform dwell time, and rapid tool switching exceed human interaction baselines.</small></span></div></section><footer><button className="button button--ghost" onClick={() => updateStatus('closed')} disabled={busy}>Close as benign</button><button className="button button--danger" onClick={() => updateStatus('contained')} disabled={busy}><ShieldCheck size={16} /> Contain source</button></footer></aside></div>
}

function App() {
  const [page, setPage] = useState<PageId>('overview')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [guided, setGuided] = useState(true)
  const [searchOpen, setSearchOpen] = useState(false)
  const [wizard, setWizard] = useState<{ open: boolean; blueprint?: BlueprintId }>({ open: false })
  const [tokenModal, setTokenModal] = useState(false)
  const [sensorModal, setSensorModal] = useState(false)
  const [selectedIncident, setSelectedIncident] = useState<Incident | null>(null)
  const [toast, setToast] = useState('')
  const [summary, setSummary] = useState(fallbackSummary)
  const [deployments, setDeployments] = useState(fallbackDeployments)
  const [incidents, setIncidents] = useState(fallbackIncidents)
  const [sensors, setSensors] = useState(fallbackSensors)
  const [deadLetters, setDeadLetters] = useState<SensorCommand[]>([])
  const [domains, setDomains] = useState(fallbackDomains)
  const [integrations, setIntegrations] = useState(fallbackIntegrations)

  useEffect(() => {
    Promise.all([
      apiGet<Summary>('summary', fallbackSummary),
      apiGet<{ items: Deployment[] }>('deployments', { items: fallbackDeployments }),
      apiGet<{ items: Incident[] }>('incidents', { items: fallbackIncidents }),
      apiGet<{ items: Sensor[] }>('sensors', { items: fallbackSensors }),
      apiGet<{ items: SensorCommand[] }>('sensor-commands?status=dead_lettered', { items: [] }),
      apiGet<{ items: Domain[] }>('domains', { items: fallbackDomains }),
      apiGet<{ items: Integration[] }>('integrations', { items: fallbackIntegrations }),
    ]).then(([nextSummary, nextDeployments, nextIncidents, nextSensors, nextDeadLetters, nextDomains, nextIntegrations]) => {
      setSummary(nextSummary); setDeployments(nextDeployments.items); setIncidents(nextIncidents.items); setSensors(nextSensors.items); setDeadLetters(nextDeadLetters.items); setDomains(nextDomains.items); setIntegrations(nextIntegrations.items)
    })
  }, [])

  useEffect(() => {
    if (!toast) return
    const timeout = window.setTimeout(() => setToast(''), 3200)
    return () => window.clearTimeout(timeout)
  }, [toast])

  const pageMeta = titleMap[page]
  const activeDeployments = useMemo(() => deployments.filter((deployment) => deployment.status !== 'provisioning').length, [deployments])
  const navigate = (destination: PageId) => { setPage(destination); setSidebarOpen(false) }
  const retryCommand = async (command: SensorCommand) => {
    try {
      await apiPost<SensorCommand>(`sensor-commands/${command.id}/retry`, {})
      setDeadLetters((current) => current.filter((item) => item.id !== command.id))
      setToast(`${command.type.replaceAll('_', ' ')} command queued for another delivery`)
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Command retry failed')
    }
  }
  const dismissCommand = async (command: SensorCommand) => {
    try {
      await apiPost<SensorCommand>(`sensor-commands/${command.id}/dismiss`, {})
      setDeadLetters((current) => current.filter((item) => item.id !== command.id))
      setToast('Dead-lettered command dismissed')
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Command dismissal failed')
    }
  }

  return (
    <div className="app-shell">
      <aside className={cx('sidebar', sidebarOpen && 'sidebar--open')}>
        <div className="brand"><span><Hexagon size={21} fill="currentColor" /></span><div><strong>AIDecepticon</strong><small>DECEPTION OPERATIONS</small></div></div>
        <nav>
          <span className="nav-label">Workspace</span>
          {navItems.map(({ id, label, icon: Icon, count }) => <button className={page === id ? 'active' : ''} onClick={() => navigate(id)} key={id}><Icon size={18} /><span>{label}</span>{count && <em>{count}</em>}</button>)}
          <span className="nav-label nav-label--secondary">Quick access</span>
          <button onClick={() => setWizard({ open: true })}><Plus size={18} /><span>New deployment</span></button>
          <button onClick={() => setTokenModal(true)}><FileKey size={18} /><span>Generate token</span></button>
        </nav>
        <div className="sidebar-posture"><div><span>Environment posture</span><strong>{summary.coverage}%</strong></div><div className="posture-bar"><span style={{ width: `${summary.coverage}%` }} /></div><small><StatusDot /> {activeDeployments} deployments healthy</small></div>
        <div className="user-card"><div className="avatar">TS</div><div><strong>Tom Saxon</strong><small>Platform administrator</small></div><ChevronRight size={16} /></div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div className="topbar__title"><button className="menu-button" onClick={() => setSidebarOpen(!sidebarOpen)}><Menu size={19} /></button><div><h1>{pageMeta.title}</h1><p>{pageMeta.subtitle}</p></div></div>
          <div className="topbar__actions">
            <button className="search-button" onClick={() => setSearchOpen(!searchOpen)}><Search size={16} /><span>Search anything</span><kbd>⌘ K</kbd></button>
            <button className={cx('guided-button', guided && 'active')} onClick={() => setGuided(!guided)}><Sparkles size={15} /> Guided mode <span>{guided ? 'On' : 'Off'}</span></button>
            <button className="icon-button notification-button"><Activity size={17} /><i /></button>
            <button className="button button--primary top-deploy" onClick={() => setWizard({ open: true })}><Plus size={16} /> Deploy</button>
          </div>
          {searchOpen && <div className="command-search"><Search size={18} /><input autoFocus placeholder="Search deployments, incidents, assets, or actions…" /><button onClick={() => setSearchOpen(false)}>Esc</button><div><span>Suggested</span><button onClick={() => { setSearchOpen(false); setWizard({ open: true }) }}><Plus size={15} /> New deception deployment</button><button onClick={() => { setSearchOpen(false); navigate('incidents') }}><ShieldAlert size={15} /> Review active detections</button><button onClick={() => { setSearchOpen(false); setTokenModal(true) }}><FileKey size={15} /> Generate canary token</button></div></div>}
        </header>

        {guided && <div className="guidance-strip"><div><Sparkles size={16} /><span><strong>Recommended next step:</strong> Add AI infrastructure deception to the ml-platform cluster to close a high-value coverage gap.</span></div><button onClick={() => setWizard({ open: true, blueprint: 'ai-infrastructure' })}>Review recommendation <ArrowRight size={14} /></button><button className="strip-close" onClick={() => setGuided(false)}><X size={15} /></button></div>}

        <main className="page-content">
          {page === 'overview' && <OverviewPage summary={summary} incidents={incidents} sensors={sensors} onDeploy={() => setWizard({ open: true })} onIncident={setSelectedIncident} onNavigate={navigate} />}
          {page === 'mesh' && <MeshPage deployments={deployments} onDeploy={(blueprint) => setWizard({ open: true, blueprint })} onToken={() => setTokenModal(true)} />}
          {page === 'incidents' && <IncidentsPage incidents={incidents} onSelect={setSelectedIncident} />}
          {page === 'surfaces' && <SurfacesPage domains={domains} sensors={sensors} deadLetters={deadLetters} onDeploy={(blueprint) => setWizard({ open: true, blueprint })} onAddSensor={() => setSensorModal(true)} onRetryCommand={retryCommand} onDismissCommand={dismissCommand} />}
          {page === 'integrations' && <IntegrationsPage integrations={integrations} onToast={setToast} />}
          {page === 'system' && <SystemPage sensors={sensors} onToast={setToast} />}
        </main>
      </div>

      {wizard.open && <DeployWizard initialBlueprint={wizard.blueprint} onClose={() => setWizard({ open: false })} onComplete={(deployment) => { setDeployments((current) => [deployment, ...current]); setWizard({ open: false }); setToast(`${deployment.name} is provisioning`) }} />}
      {tokenModal && <TokenModal onClose={() => setTokenModal(false)} onComplete={setToast} />}
      {sensorModal && <SensorEnrollmentModal onClose={() => setSensorModal(false)} onToast={setToast} />}
      {selectedIncident && <IncidentDrawer incident={selectedIncident} onClose={() => setSelectedIncident(null)} onUpdate={(updated) => { setIncidents((current) => current.map((item) => item.id === updated.id ? updated : item)); setSelectedIncident(updated); setToast(`Incident ${updated.id} updated`) }} />}
      {toast && <div className="toast"><CheckCircle2 size={17} />{toast}</div>}
    </div>
  )
}

export default App
