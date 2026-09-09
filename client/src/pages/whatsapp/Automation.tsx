import { useState } from 'react';
import { PageHeader } from '../../components/Shell';
import Templates from './automation/Templates';
import Automations from './automation/Automations';
import Logs from './automation/Logs';
import { Triggers, Variables } from './automation/Reference';
import Knowledge from './Knowledge';
import { AgentConfig, Accounts } from './Settings';
import { MetaTemplates, Campaigns } from './Broadcasts';

// The whole WhatsApp Automation section (spec §1 and §15). Everything an admin can change
// about what ARIA sends, knows and hands off lives behind these tabs.
const TABS = ['Templates', 'Automations', 'Triggers', 'Variables', 'Logs', 'AI Settings', 'Knowledge Base', 'Broadcasts', 'Accounts'] as const;
type Tab = typeof TABS[number];

export default function WhatsAppAutomation() {
  const [tab, setTab] = useState<Tab>('Templates');
  return <>
    <PageHeader
      title="WhatsApp Automation"
      subtitle="ARIA's templates, triggers, automations and run history — every customer-facing message lives here, not in code."
      backTo="/whatsapp" backLabel="Back to inbox"
    />
    <div className="border-b bg-white px-4">
      <nav className="flex flex-wrap gap-1">
        {TABS.map(item => <button key={item}
          className={`border-b-2 px-3 py-2.5 text-xs font-semibold transition-colors ${tab === item ? 'border-[#0ea5e9] text-[#0284c7]' : 'border-transparent text-slate-500 hover:text-slate-800'}`}
          onClick={() => setTab(item)}>{item}</button>)}
      </nav>
    </div>
    <div className="p-4">
      {tab === 'Templates' && <Templates />}
      {tab === 'Automations' && <Automations />}
      {tab === 'Triggers' && <Triggers />}
      {tab === 'Variables' && <Variables />}
      {tab === 'Logs' && <Logs />}
      {tab === 'AI Settings' && <AgentConfig />}
      {tab === 'Knowledge Base' && <Knowledge />}
      {tab === 'Broadcasts' && <div className="space-y-6"><MetaTemplates /><Campaigns /></div>}
      {tab === 'Accounts' && <Accounts />}
    </div>
  </>;
}
