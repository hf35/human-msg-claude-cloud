import { historyResponseSchema, type HistoryItemDto } from '@human-msg/shared';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Empty, Space, Spin, Tag, Typography } from 'antd';
import { formatTime } from '../format';
import { AdminApiError, http } from '../providers/http';
import { errorText, texts } from '../texts';

const t = texts.history;

const statusColor = {
  queued: 'blue',
  assigned: 'gold',
  answered: 'green',
  expired: 'red',
} as const;

function Item({ item }: { item: HistoryItemDto }) {
  if (item.kind === 'question') {
    return (
      <Card size="small" title={`${t.asked} · ${formatTime(item.createdAt)}`}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Space>
            <Tag color={statusColor[item.status]}>{texts.questionStatus[item.status]}</Tag>
          </Space>
          <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
            {item.text}
          </Typography.Paragraph>
          {item.answer ? (
            <Card
              size="small"
              type="inner"
              title={`${t.answerFrom} ${item.answer.responderAlias} · ${formatTime(item.answer.createdAt)}`}
            >
              <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
                {item.answer.text}
              </Typography.Paragraph>
            </Card>
          ) : (
            <Typography.Text type="secondary">{t.noAnswer}</Typography.Text>
          )}
        </Space>
      </Card>
    );
  }
  return (
    <Card size="small" title={`${t.answeredTo} · ${formatTime(item.createdAt)}`}>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Card size="small" type="inner" title={`${t.questionOf} ${item.authorAlias}`}>
          <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
            {item.questionText}
          </Typography.Paragraph>
        </Card>
        <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
          {item.text}
        </Typography.Paragraph>
      </Space>
    </Card>
  );
}

/** What the user asked (with the answers) and what they answered, newest first. */
export function History({ userId }: { userId: string }) {
  const history = useInfiniteQuery({
    queryKey: ['backoffice', 'users', userId, 'history'],
    queryFn: async ({ pageParam }) =>
      historyResponseSchema.parse(
        await http('GET', `/users/${encodeURIComponent(userId)}/history`, {
          query: { limit: 20, ...(pageParam && { cursor: pageParam }) },
        }),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });

  if (history.isPending) return <Spin />;
  if (history.isError) {
    return (
      <Alert
        type="error"
        message={errorText(history.error instanceof AdminApiError ? history.error.code : '')}
      />
    );
  }
  const items = history.data.pages.flatMap((page) => page.items);
  if (items.length === 0) return <Empty description={t.empty} />;

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      {items.map((item) => (
        <Item key={`${item.kind}:${item.id}`} item={item} />
      ))}
      {history.hasNextPage && (
        <Button onClick={() => history.fetchNextPage()} loading={history.isFetchingNextPage}>
          {t.more}
        </Button>
      )}
    </Space>
  );
}
