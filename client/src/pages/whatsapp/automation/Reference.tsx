import { useQuery } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import type { AutomationCatalogue, AutomationTemplate, VariableDefinition } from '../../../lib/types';
import { Loading } from '../../../components/ui';

const SCOPE_TONE: Record<string, string> = {
  customer: 'bg-emerald-100 text-emerald-700',
  internal: 'bg-amber-100 text-amber-700',
  system: 'bg-slate-100 text-slate-600',
};

const useCatalogue = () => useQuery({ queryKey: ['automation-catalogue'], queryFn: () => api<AutomationCatalogue>('/automation/catalogue'), staleTime: 300000 });

/** Which templates listen on each trigger — the answer to "why did nothing happen?". */
export function Triggers() {
  const catalogue = useCatalogue();
  const templates = useQuery({ queryKey: ['automation-templates', '', '', ''], queryFn: () => api<AutomationTemplate[]>('/automation-templates') });
  if (catalogue.isLoading) return <Loading />;

  return <div className="space-y-3">
    <p className="text-xs text-slate-500">Every event ARIA can react to. A trigger with no active template or automation simply does nothing.</p>
    <div className="panel divide-y">
      {(catalogue.data?.triggers ?? []).map(trigger => {
        const listening = (templates.data ?? []).filter(template => template.trigger === trigger.key);
        return <div key={trigger.key} className="p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <b>{trigger.label}</b>
            <span className="font-mono text-[11px] text-slate-400">{trigger.key}</span>
            <span className={`badge ${SCOPE_TONE[trigger.scope]}`}>{trigger.scope}</span>
          </div>
          <p className="mt-0.5 text-xs text-slate-500">{trigger.description}</p>
          <p className="mt-1 text-[11px] text-slate-400">
            {listening.length
              ? <>Templates: {listening.map(template => `${template.templateName} (${template.status})`).join(', ')}</>
              : 'No template listens on this trigger yet.'}
          </p>
        </div>;
      })}
    </div>
  </div>;
}

/** The variable reference, grouped exactly as the template editor's palette shows them. */
export function Variables() {
  const catalogue = useCatalogue();
  if (catalogue.isLoading) return <Loading />;
  const groups = new Map<string, VariableDefinition[]>();
  for (const variable of catalogue.data?.variables ?? []) {
    if (!groups.has(variable.group)) groups.set(variable.group, []);
    groups.get(variable.group)!.push(variable);
  }

  return <div className="space-y-3">
    <div className="rounded border border-sky-100 bg-sky-50 p-3 text-xs text-sky-900">
      Variables are resolved from the lead, contact, conversation, knowledge base and the event that fired the automation.
      A variable with no value is never sent as <code>{'{{name}}'}</code>: the line is dropped, a safe fallback is used, or —
      if the template marks it required — the message is not sent at all.
    </div>
    {[...groups.entries()].map(([group, variables]) => <div key={group} className="panel">
      <div className="border-b bg-[#fafafa] px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{group}</div>
      <table className="w-full text-sm">
        <tbody className="divide-y">
          {variables.map(variable => <tr key={variable.name}>
            <td className="w-56 p-2 pl-3 font-mono text-xs text-[#0369a1]">{`{{${variable.name}}}`}</td>
            <td className="p-2 text-xs">{variable.label}</td>
            <td className="p-2 pr-3 text-xs text-slate-400">e.g. {variable.sample}</td>
          </tr>)}
        </tbody>
      </table>
    </div>)}
  </div>;
}
