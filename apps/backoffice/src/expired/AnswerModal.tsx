import { DEFAULT_SETTINGS, validateMessageText, type AdminQuestionDto } from '@human-msg/shared';
import { useMutation } from '@tanstack/react-query';
import { App, Form, Input, Modal, Typography } from 'antd';
import { AdminApiError, http } from '../providers/http';
import { useSettings } from '../settings';
import { errorText, texts } from '../texts';

const t = texts.expired;

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
/** Characters as a person sees them (an emoji is one), as the server counts them. */
const countCharacters = (text: string): number => [...graphemes.segment(text)].length;

interface Props {
  question: AdminQuestionDto;
  onClose: () => void;
  /** The question is answered (or someone else answered it first): it leaves the journal. */
  onAnswered: () => void;
}

/** A staff answer to a question nobody answered in time. */
export function AnswerModal({ question, onClose, onAnswered }: Props) {
  const [form] = Form.useForm<{ text: string }>();
  const { message } = App.useApp();
  const settings = useSettings();
  const maxLength =
    // The default until the settings arrive; the server checks the text again anyway
    settings.data?.settings.MESSAGE_MAX_LENGTH ?? DEFAULT_SETTINGS.MESSAGE_MAX_LENGTH;

  const send = useMutation({
    mutationFn: (text: string) =>
      http('POST', `/questions/${encodeURIComponent(question.id)}/staff-answer`, {
        body: { text },
      }),
    onSuccess: () => {
      message.success(t.sent);
      onAnswered();
    },
    onError: (error) => {
      const code = error instanceof AdminApiError ? error.code : 'unknown';
      message.error(errorText(code));
      // Answered meanwhile (by another tab or person): nothing to send any more
      if (code === 'not_expired' || code === 'not_found') onAnswered();
    },
  });

  return (
    <Modal
      open
      title={t.modalTitle}
      okText={t.send}
      cancelText={t.cancel}
      confirmLoading={send.isPending}
      onOk={() => form.submit()}
      onCancel={onClose}
      destroyOnHidden
    >
      <Typography.Text type="secondary">{t.question}</Typography.Text>
      <Typography.Paragraph style={{ whiteSpace: 'pre-wrap' }}>
        {question.text}
      </Typography.Paragraph>
      <Form form={form} layout="vertical" onFinish={({ text }) => send.mutate(text)}>
        <Form.Item
          name="text"
          label={t.yourAnswer}
          rules={[
            {
              // The same rules as for every message (CLAUDE.md, "Только текст")
              validator: async (_, value: string | undefined) => {
                const checked = validateMessageText(value ?? '', maxLength);
                if (!checked.ok) throw new Error(texts.messageErrors[checked.reason]);
              },
            },
          ]}
        >
          <Input.TextArea
            autoSize={{ minRows: 4, maxRows: 12 }}
            autoFocus
            // Not `maxLength`: it would cut a pasted text silently. The counter turns red instead
            // and the validator above refuses to send
            count={{ show: true, max: maxLength, strategy: countCharacters }}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}
