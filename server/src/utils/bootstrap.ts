import { ActivityType, PipelineStage } from '../models/index.js';

// A workspace created through the admin signup flow (rather than `npm run seed`) has no
// master data, so the first lead conversion dead-ends on "Configure a pipeline stage" —
// and the WhatsApp agent's automatic convert-on-won does the same, silently. These
// defaults are created only when the collection is completely empty, so they never fight
// with stages an admin has renamed, reordered, or deleted.
const DEFAULT_STAGES = [
  { name: 'New', sequence: 10, probability: 10, color: '#64748b' },
  { name: 'Contacted', sequence: 20, probability: 20, color: '#0ea5e9' },
  { name: 'Qualified', sequence: 30, probability: 40, color: '#3b82f6' },
  { name: 'Proposal', sequence: 40, probability: 60, color: '#8b5cf6' },
  { name: 'Negotiation', sequence: 50, probability: 80, color: '#f59e0b' },
  { name: 'Won', sequence: 60, probability: 100, color: '#10b981', isWon: true },
];

const DEFAULT_ACTIVITY_TYPES = [
  { name: 'Call', defaultDays: 1 }, { name: 'Email', defaultDays: 2 }, { name: 'Meeting', defaultDays: 3 },
  { name: 'Demo', defaultDays: 3 }, { name: 'Callback', defaultDays: 1 }, { name: 'Follow-up', defaultDays: 2 },
];

let ensured = false;

export async function ensureWorkspaceDefaults(force = false) {
  if (ensured && !force) return;
  ensured = true;
  try {
    if (await PipelineStage.estimatedDocumentCount() === 0) {
      await PipelineStage.insertMany(DEFAULT_STAGES.map(stage => ({ ...stage, active: true })));
      console.log('Created default pipeline stages');
    }
    if (await ActivityType.estimatedDocumentCount() === 0) {
      await ActivityType.insertMany(DEFAULT_ACTIVITY_TYPES.map(type => ({ ...type, active: true, icon: 'check' })));
      console.log('Created default activity types');
    }
  } catch (error) {
    ensured = false; // let a later request retry rather than leaving the workspace unusable
    console.error('[bootstrap] could not create workspace defaults', error);
  }
}
