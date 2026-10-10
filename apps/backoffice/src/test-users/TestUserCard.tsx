import {
  stateResponseSchema,
  validateMessageText,
  DEFAULT_SETTINGS,
  type AdminUserDto,
} from '@human-msg/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, Form, Input, Space, Switch, Tag, Tooltip, Typography } from 'antd';
import { Link } from 'react-router';
import { formatTime } from '../format';
import { AdminApiError, http } from '../providers/http';
import { useSettings } from '../settings/useSettings';
import { errorText, texts } from '../texts';

const t = texts.testUsers;

/** Every query of the test users page starts with this: one action refreshes all cards. */
export const TEST_USERS_KEY = ['backoffice', 'test-users'] as const;
/** Other test users act too (and the worker): the cards follow without a reload. */
const REFRESH_MS = 3000;

const stateOf = (id: string) => async () =>
  stateResponseSchema.parse(await http('GET', `/test-users/${encodeURIComponent(id)}/state`));

type SendResult = { kind: 'answered' } | { kind: 'asked'; status: 'queued' | 'assigned' };

/** One test user: what they see on their screen and what they can do. */
export function TestUserCard({ user }: { user: AdminUserDto }) {
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const [form] = Form.useForm<{ text: string }>();
  const settings = useSettings();
  const maxLength =
    settings.data?.settings.MESSAGE_MAX_LENGTH ?? DEFAULT_SETTINGS.MESSAGE_MAX_LENGTH;
  const path = `/test-users/${encodeURIComponent(user.id)}`;

  const state = useQuery({
    queryKey: [...TEST_USERS_KEY, user.id, 'state'],
    queryFn: stateOf(user.id),
    refetchInterval: REFRESH_MS,
  });

  // An action of one test user can change every card: a question moves to another user
  const refreshAll = () => queryClient.invalidateQueries({ queryKey: TEST_USERS_KEY });
  const fail = (error: Error) => {
    message.error(errorText(error instanceof AdminApiError ? error.code : 'unknown'));
    void refreshAll();
  };

  const receiving = useMutation({
    mutationFn: (receivingEnabled: boolean) =>
      http('PUT', `${path}/receiving`, { body: { receivingEnabled } }),
    onSuccess: refreshAll,
    onError: fail,
  });

  const send = useMutation({
    mutationFn: (text: string) => http<SendResult>('POST', `${path}/messages`, { body: { text } }),
    onSuccess: (result) => {
      form.resetFields();
      message.success(
        result.kind === 'answered'
          ? t.answered
          : result.status === 'queued'
            ? t.askedQueued
            : t.asked,
      );
      void refreshAll();
    },
    onError: fail,
  });

  const skip = useMutation({
    mutationFn: () => http('POST', `${path}/skip`),
    onSuccess: () => {
      message.success(t.skipped);
      void refreshAll();
    },
    onError: fail,
  });

  const assignment = state.data?.assignment ?? null;
  const pending = state.data?.pendingQuestion ?? null;
  const cooldown =
    user.cooldownUntil && new Date(user.cooldownUntil) > new Date() ? user.cooldownUntil : null;

  return (
    <Card
      size="small"
      title={
        <Space wrap>
          <Link to={`/users/${user.id}`}>{user.alias}</Link>
          <Tag>{user.locale}</Tag>
        </Space>
      }
      extra={
        <Tooltip title={t.availableHint}>
          <Space>
            <span>{t.available}</span>
            <Switch
              aria-label={`${t.available}: ${user.alias}`}
              checked={user.receivingEnabled}
              loading={receiving.isPending}
              onChange={(checked) => receiving.mutate(checked)}
            />
          </Space>
        </Tooltip>
      }
    >
      <Space direction="vertical" style={{ width: '100%' }}>
        {cooldown && (
          <Typography.Text type="secondary">
            {t.cooldown} {formatTime(cooldown)}
          </Typography.Text>
        )}
        {assignment && (
          <Card
            size="small"
            type="inner"
            title={`${t.incoming} ${assignment.authorAlias}`}
            extra={
              <Typography.Text type="secondary">
                {t.deadline} {formatTime(assignment.deadlineAt)}
              </Typography.Text>
            }
          >
            <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
              {assignment.text}
            </Typography.Paragraph>
          </Card>
        )}
        {pending && (
          <Card
            size="small"
            type="inner"
            title={
              <Space>
                {t.pending}
                <Tag color={pending.status === 'queued' ? 'blue' : 'gold'}>
                  {texts.questionStatus[pending.status]}
                </Tag>
              </Space>
            }
          >
            <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
              {pending.text}
            </Typography.Paragraph>
          </Card>
        )}
        {state.isSuccess && !assignment && !pending && (
          <Typography.Text type="secondary">{t.idle}</Typography.Text>
        )}

        <Form form={form} onFinish={({ text }) => send.mutate(text)}>
          <Form.Item
            name="text"
            style={{ marginBottom: 8 }}
            rules={[
              {
                validator: async (_, value: string | undefined) => {
                  const checked = validateMessageText(value ?? '', maxLength);
                  if (!checked.ok) throw new Error(errorText(checked.reason));
                },
              },
            ]}
          >
            <Input.TextArea
              aria-label={`${t.message}: ${user.alias}`}
              autoSize={{ minRows: 2, maxRows: 8 }}
              placeholder={assignment ? t.answer : t.ask}
            />
          </Form.Item>
          <Space wrap>
            {/* Rule 1: with a question assigned, any message is the answer to it */}
            <Button type="primary" htmlType="submit" loading={send.isPending}>
              {assignment ? t.answer : t.ask}
            </Button>
            {assignment && (
              <Button onClick={() => skip.mutate()} loading={skip.isPending}>
                {t.skip}
              </Button>
            )}
          </Space>
        </Form>
      </Space>
    </Card>
  );
}
