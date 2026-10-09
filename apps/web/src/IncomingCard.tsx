import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { MeResponse, StateResponse } from '@human-msg/shared';
import { useState, type FormEvent } from 'react';
import { ApiError, api } from './api';
import { describeSendError } from './errors';
import { useI18n } from './i18n';
import { formatCountdown, useCountdown } from './useCountdown';

type Assignment = NonNullable<StateResponse['assignment']>;

interface Props {
  me: MeResponse;
  assignment: Assignment;
  /** Tells the user something that is not an error of the form (see `Home`). */
  notify(message: string): void;
}

/**
 * A question for the user to answer: who asks (by alias), how long is left, a field for the
 * answer, and the ways out: skip, or report. Whatever the user writes is the answer (rule 1).
 */
export function IncomingCard({ me, assignment, notify }: Props) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const [confirmingReport, setConfirmingReport] = useState(false);
  const secondsLeft = useCountdown(assignment.deadlineAt);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['state'] }),
      queryClient.invalidateQueries({ queryKey: ['me'] }),
      queryClient.invalidateQueries({ queryKey: ['history'] }),
    ]);

  const answer = useMutation({
    mutationFn: api.sendMessage,
    onSuccess: async (result) => {
      setText('');
      // The assignment ran out a moment ago: the server took the text as a new question
      if (result.kind === 'asked') notify(t.rejections.answerTimeExpired);
      await refresh();
    },
    onError: () => void refresh(),
  });

  // The assignment may be gone already (time ran out); then there is nothing to skip or report
  const gone = (error: unknown) =>
    error instanceof ApiError && error.code === 'no_active_assignment';
  const skip = useMutation({
    mutationFn: api.skip,
    onSuccess: async () => {
      notify(t.notifications.skipped);
      await refresh();
    },
    onError: async (error) => {
      if (gone(error)) notify(t.rejections.answerTimeExpired);
      await refresh();
    },
  });
  const report = useMutation({
    mutationFn: () => api.report({ target: 'question' }),
    onSuccess: async () => {
      notify(t.notifications.reported);
      await refresh();
    },
    onError: async (error) => {
      if (gone(error)) notify(t.rejections.answerTimeExpired);
      await refresh();
    },
  });

  const busy = answer.isPending || skip.isPending || report.isPending;
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (text.trim() && !busy) answer.mutate(text);
  };
  const failure = [skip.error, report.error].find((error) => error && !gone(error));

  return (
    <form
      className="card"
      onSubmit={onSubmit}
      aria-label={t.web.incoming.from(assignment.authorAlias)}
    >
      <h2>{t.web.incoming.from(assignment.authorAlias)}</h2>
      <blockquote data-testid="incoming">{assignment.text}</blockquote>
      <p className="hint" data-testid="countdown">
        {secondsLeft > 0
          ? t.web.incoming.timeLeft(formatCountdown(secondsLeft))
          : t.web.incoming.timeUp}
      </p>

      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={t.web.incoming.placeholder}
        aria-label={t.web.incoming.placeholder}
        rows={4}
      />
      {answer.isError && (
        <p role="alert" className="error">
          {describeSendError(answer.error, t, me)}
        </p>
      )}
      {failure && (
        <p role="alert" className="error">
          {failure instanceof ApiError && failure.code === 'network'
            ? t.web.errors.network
            : t.errors.generic}
        </p>
      )}

      <div className="actions">
        <button type="submit" disabled={busy || !text.trim()}>
          {t.web.incoming.send}
        </button>
        <button type="button" disabled={busy} onClick={() => skip.mutate()}>
          {t.buttons.skip}
        </button>
        {!confirmingReport && (
          <button type="button" disabled={busy} onClick={() => setConfirmingReport(true)}>
            {t.buttons.report}
          </button>
        )}
      </div>

      {confirmingReport && (
        <div role="alertdialog" className="confirm" aria-label={t.buttons.report}>
          <p>{t.web.incoming.reportConfirm}</p>
          <button type="button" disabled={busy} onClick={() => report.mutate()}>
            {t.web.incoming.reportYes}
          </button>
          <button type="button" onClick={() => setConfirmingReport(false)}>
            {t.web.incoming.cancel}
          </button>
        </div>
      )}
    </form>
  );
}
