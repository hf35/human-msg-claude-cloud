import { adminUsersResponseSchema, type AdminUserDto } from '@human-msg/shared';
import { List } from '@refinedev/antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Col, Empty, Row, Select, Space, Spin } from 'antd';
import { useState } from 'react';
import { AdminApiError, http } from '../providers/http';
import { errorText, texts } from '../texts';
import { TEST_USERS_KEY, TestUserCard } from './TestUserCard';

const t = texts.testUsers;

/** The server's page limit; more test users than this are not needed to play a scene. */
const LIMIT = 100;

/** Test users side by side: each asks, answers and skips as a separate person would. */
export function TestUserList() {
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const [locale, setLocale] = useState<'ru' | 'en'>('ru');

  const users = useQuery({
    queryKey: [...TEST_USERS_KEY, 'list'],
    queryFn: async () =>
      adminUsersResponseSchema.parse(
        await http('GET', '/users', { query: { isTest: true, limit: LIMIT } }),
      ),
    // Cooldowns and availability change with every action of any test user
    refetchInterval: 3000,
  });

  const create = useMutation({
    mutationFn: () => http<AdminUserDto>('POST', '/test-users', { body: { locale } }),
    onSuccess: (user) => {
      message.success(`${t.created}: ${user.alias}`);
      void queryClient.invalidateQueries({ queryKey: TEST_USERS_KEY });
    },
    onError: (error) =>
      message.error(errorText(error instanceof AdminApiError ? error.code : 'unknown')),
  });

  // Oldest first: the cards keep their places as new test users are added
  const items = [...(users.data?.items ?? [])].reverse();

  return (
    <List
      title={t.title}
      headerButtons={
        <Space>
          <Select
            aria-label={t.locale}
            value={locale}
            onChange={setLocale}
            options={[
              { value: 'ru', label: 'Русский' },
              { value: 'en', label: 'English' },
            ]}
          />
          <Button type="primary" onClick={() => create.mutate()} loading={create.isPending}>
            {t.create}
          </Button>
        </Space>
      }
    >
      <Alert type="info" showIcon message={t.hint} style={{ marginBottom: 16 }} />
      {users.isPending && <Spin />}
      {users.isError && (
        <Alert
          type="error"
          message={errorText(users.error instanceof AdminApiError ? users.error.code : '')}
        />
      )}
      {users.isSuccess && items.length === 0 && <Empty description={t.empty} />}
      <Row gutter={[16, 16]}>
        {items.map((user) => (
          <Col key={user.id} xs={24} lg={12} xxl={8}>
            <TestUserCard user={user} />
          </Col>
        ))}
      </Row>
    </List>
  );
}
