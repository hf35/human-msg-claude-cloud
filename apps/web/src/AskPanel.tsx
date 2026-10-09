import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { MeResponse, StateResponse } from '@human-msg/shared';
import { useState, type FormEvent } from 'react';
import { api } from './api';
import { describeSendError } from './errors';
import { useI18n } from './i18n';

interface Props {
  me: MeResponse;
  pendingQuestion: StateResponse['pendingQuestion'];
}

/**
 * The author's side: a field for a new question, or, while the question has no answer, its
 * status ("looking for someone to answer"). A user who has to answer a question of somebody else
 * does not see this panel: whatever they write is the answer (rule 1).
 */
export function AskPanel({ me, pendingQuestion }: Props) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [text, setText] = useState('');

  const send = useMutation({
    mutationFn: api.sendMessage,
    onSuccess: async () => {
      setText('');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['state'] }),
        queryClient.invalidateQueries({ queryKey: ['me'] }),
      ]);
    },
    // A refusal can mean our picture is stale (someone answered, the limit moved): look again
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: ['state'] });
      void queryClient.invalidateQueries({ queryKey: ['me'] });
    },
  });

  if (pendingQuestion) {
    return (
      <section className="card" aria-label={t.web.state.waiting}>
        <p className="hint">{t.web.state.waiting}</p>
        <blockquote data-testid="pending">{pendingQuestion.text}</blockquote>
        <p role="status" data-testid="pending-status">
          {pendingQuestion.status === 'queued'
            ? t.notifications.questionQueued
            : t.web.ask.assigned}
        </p>
      </section>
    );
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (text.trim() && !send.isPending) send.mutate(text);
  };

  return (
    <form className="card" onSubmit={onSubmit}>
      <h2>{t.web.ask.title}</h2>
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={t.web.ask.placeholder}
        aria-label={t.web.ask.title}
        rows={4}
      />
      <p className="hint">{t.web.ask.remaining(me.questionLimit.remaining)}</p>
      {send.isError && (
        <p role="alert" className="error">
          {describeSendError(send.error, t, me)}
        </p>
      )}
      <button type="submit" disabled={send.isPending || !text.trim()}>
        {t.web.ask.send}
      </button>
    </form>
  );
}
