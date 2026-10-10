import type { AdminQuestionDto } from '@human-msg/shared';
import { Tag } from 'antd';
import { texts } from '../texts';

type Status = AdminQuestionDto['status'];
type Outcome = AdminQuestionDto['assignments'][number]['outcome'];

const statusColor: Record<Status, string> = {
  queued: 'blue',
  assigned: 'gold',
  answered: 'green',
  expired: 'red',
};

export function StatusTag({ status }: { status: Status }) {
  return <Tag color={statusColor[status]}>{texts.questionStatus[status]}</Tag>;
}

const outcomeColor: Record<NonNullable<Outcome> | 'active', string> = {
  active: 'gold',
  answered: 'green',
  timed_out: 'default',
  skipped: 'default',
  reported: 'red',
  undeliverable: 'red',
};

/** How an assignment ended; `null` is one still waiting for the answer. */
export function OutcomeTag({ outcome }: { outcome: Outcome }) {
  const key = outcome ?? 'active';
  return <Tag color={outcomeColor[key]}>{texts.outcome[key]}</Tag>;
}
