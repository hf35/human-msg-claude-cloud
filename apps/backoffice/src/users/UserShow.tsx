import type { AdminUserDto } from '@human-msg/shared';
import { Show } from '@refinedev/antd';
import { useShow } from '@refinedev/core';
import { Alert, Descriptions, Typography } from 'antd';
import { formatTime } from '../format';
import { AdminApiError } from '../providers/http';
import { errorText, texts } from '../texts';
import { History } from './History';
import { KindTag, ReceivingTag } from './UserList';

const t = texts.users;

export function UserShow() {
  const { query } = useShow<AdminUserDto>();
  const user = query.data?.data;

  return (
    <Show
      title={user?.alias ?? t.card}
      isLoading={query.isLoading}
      canEdit={false}
      canDelete={false}
    >
      {query.isError && (
        <Alert
          type="error"
          message={
            query.error instanceof AdminApiError ? errorText(query.error.code) : errorText('')
          }
        />
      )}
      {user && (
        <>
          <Descriptions bordered size="small" column={{ xs: 1, md: 2 }}>
            <Descriptions.Item label={t.alias}>{user.alias}</Descriptions.Item>
            <Descriptions.Item label={t.kind}>
              <KindTag user={user} />
            </Descriptions.Item>
            <Descriptions.Item label={t.channel}>{texts.channels[user.channel]}</Descriptions.Item>
            <Descriptions.Item label={t.locale}>{user.locale}</Descriptions.Item>
            {user.telegramId !== null && (
              <Descriptions.Item label={t.telegramId}>{user.telegramId}</Descriptions.Item>
            )}
            <Descriptions.Item label={t.receiving}>
              <ReceivingTag user={user} />
            </Descriptions.Item>
            <Descriptions.Item label={t.cooldownUntil}>
              {formatTime(user.cooldownUntil)}
            </Descriptions.Item>
            <Descriptions.Item label={t.missedDeadlines}>{user.missedDeadlines}</Descriptions.Item>
            <Descriptions.Item label={t.asked}>{user.questionsAsked}</Descriptions.Item>
            <Descriptions.Item label={t.answered}>{user.answersGiven}</Descriptions.Item>
            <Descriptions.Item label={t.lastSeen}>{formatTime(user.lastSeenAt)}</Descriptions.Item>
            <Descriptions.Item label={t.createdAt}>{formatTime(user.createdAt)}</Descriptions.Item>
            <Descriptions.Item label={t.id}>
              <Typography.Text copyable>{user.id}</Typography.Text>
            </Descriptions.Item>
          </Descriptions>
          <Typography.Title level={4} style={{ marginTop: 24 }}>
            {texts.history.title}
          </Typography.Title>
          <History userId={user.id} version={query.dataUpdatedAt} />
        </>
      )}
    </Show>
  );
}
