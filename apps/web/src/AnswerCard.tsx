import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, api } from './api';
import { useI18n } from './i18n';
import type { AnsweredQuestion } from './useNewAnswers';

/**
 * An answer to the user's question, shown together with the question: it can arrive hours later,
 * when the user has asked something else. The author may report the answer, after which its
 * author never answers them again.
 */
export function AnswerCard({ item }: { item: AnsweredQuestion }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);

  const report = useMutation({
    mutationFn: () => api.report({ target: 'answer', questionId: item.questionId }),
    onSuccess: () => setConfirming(false),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['history'] }),
  });

  return (
    <section className="card answer" data-testid="answer-card">
      <h2>{t.notifications.answerReceived(item.answer.responderAlias)}</h2>
      <p className="hint">{t.web.answer.yourQuestion}</p>
      <blockquote data-testid="answer-question">{item.text}</blockquote>
      <p className="hint">{t.web.answer.theAnswer}</p>
      <blockquote data-testid="answer-text">{item.answer.text}</blockquote>

      {report.isSuccess ? (
        <p role="status">{t.web.answer.reportDone}</p>
      ) : confirming ? (
        <div role="alertdialog" className="confirm" aria-label={t.buttons.report}>
          <p>{t.web.answer.reportConfirm}</p>
          <button type="button" disabled={report.isPending} onClick={() => report.mutate()}>
            {t.web.incoming.reportYes}
          </button>
          <button type="button" onClick={() => setConfirming(false)}>
            {t.web.incoming.cancel}
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => setConfirming(true)}>
          {t.buttons.report}
        </button>
      )}
      {report.isError && (
        <p role="alert" className="error">
          {report.error instanceof ApiError && report.error.code === 'network'
            ? t.web.errors.network
            : t.errors.generic}
        </p>
      )}
    </section>
  );
}
