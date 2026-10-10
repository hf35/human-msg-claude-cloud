import type { AdminUserDto } from '@human-msg/shared';
import { List, useTable } from '@refinedev/antd';
import type { CrudFilters } from '@refinedev/core';
import { useState } from 'react';
import { Link } from 'react-router';
import { Button, DatePicker, Form, Input, Select, Space, Table, Tag } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { formatTime } from '../format';
import { texts } from '../texts';

const t = texts.users;

type Kind = 'live' | 'test' | 'staff';

interface Search {
  search?: string;
  channel?: 'web' | 'telegram';
  kind?: Kind;
  created?: [Dayjs | null, Dayjs | null] | null;
}

/** The query parameters of `GET /admin/api/users` for the search form. */
export function toFilters({ search, channel, kind, created }: Search): CrudFilters {
  const [from, to] = created ?? [];
  // `undefined` values clear a filter that was set before
  return [
    { field: 'search', operator: 'eq', value: search?.trim() || undefined },
    { field: 'channel', operator: 'eq', value: channel },
    { field: 'isTest', operator: 'eq', value: kind ? kind === 'test' : undefined },
    { field: 'isStaff', operator: 'eq', value: kind ? kind === 'staff' : undefined },
    { field: 'createdFrom', operator: 'eq', value: from?.startOf('day').toISOString() },
    // The server's bound is exclusive: the whole last day is included
    { field: 'createdTo', operator: 'eq', value: to?.add(1, 'day').startOf('day').toISOString() },
  ];
}

/** The search form for filters already in force (from the address after a reload). */
export function fromFilters(filters: CrudFilters): Search {
  const value = (field: string): unknown => {
    const found = filters.find((filter) => 'field' in filter && filter.field === field);
    return found?.value;
  };
  const isTest = String(value('isTest'));
  const isStaff = String(value('isStaff'));
  const from = value('createdFrom');
  const to = value('createdTo');
  return {
    search: value('search') as string | undefined,
    channel: value('channel') as Search['channel'],
    kind:
      isStaff === 'true'
        ? 'staff'
        : isTest === 'true'
          ? 'test'
          : isTest === 'false'
            ? 'live'
            : undefined,
    created:
      from || to
        ? [
            from ? dayjs(String(from)) : null,
            // The bound is the start of the next day: the picker shows the last day included
            to ? dayjs(String(to)).subtract(1, 'day') : null,
          ]
        : null,
  };
}

export function KindTag({ user }: { user: Pick<AdminUserDto, 'isTest' | 'isStaff'> }) {
  if (user.isStaff) return <Tag color="purple">{t.staff}</Tag>;
  if (user.isTest) return <Tag color="orange">{t.test}</Tag>;
  return <Tag>{t.live}</Tag>;
}

/** Whether questions can reach the user, and why not when they cannot. */
export function ReceivingTag({ user }: { user: AdminUserDto }) {
  if (user.botBlockedAt) return <Tag color="red">{t.botBlocked}</Tag>;
  if (!user.receivingEnabled) return <Tag color="default">{t.receivingOff}</Tag>;
  return <Tag color="green">{texts.yes}</Tag>;
}

export function UserList() {
  const { tableProps, searchFormProps, filters } = useTable<AdminUserDto, never, Search>({
    syncWithLocation: true,
    sorters: { mode: 'off' },
    onSearch: toFilters,
  });
  // Read once: the filters of the address the page was opened with
  const [initialSearch] = useState(() => fromFilters(filters));

  return (
    <List title={t.title}>
      <Form
        {...searchFormProps}
        initialValues={initialSearch}
        layout="inline"
        style={{ marginBottom: 16, rowGap: 8 }}
      >
        <Form.Item name="search">
          <Input.Search placeholder={t.search} allowClear style={{ width: 220 }} />
        </Form.Item>
        <Form.Item name="channel" label={t.channel}>
          <Select
            allowClear
            placeholder={texts.any}
            style={{ width: 140 }}
            options={[
              { value: 'web', label: texts.channels.web },
              { value: 'telegram', label: texts.channels.telegram },
            ]}
          />
        </Form.Item>
        <Form.Item name="kind" label={t.kind}>
          <Select
            allowClear
            placeholder={texts.any}
            style={{ width: 150 }}
            options={[
              { value: 'live', label: t.live },
              { value: 'test', label: t.test },
              { value: 'staff', label: t.staff },
            ]}
          />
        </Form.Item>
        <Form.Item name="created" label={t.createdRange}>
          <DatePicker.RangePicker allowEmpty={[true, true]} format="DD.MM.YYYY" />
        </Form.Item>
        <Space>
          <Button type="primary" htmlType="submit">
            {t.find}
          </Button>
          <Button
            onClick={() => {
              searchFormProps.form?.setFieldsValue({
                search: undefined,
                channel: undefined,
                kind: undefined,
                created: undefined,
              });
              searchFormProps.form?.submit();
            }}
          >
            {t.reset}
          </Button>
        </Space>
      </Form>

      <Table {...tableProps} rowKey="id" scroll={{ x: true }}>
        <Table.Column<AdminUserDto>
          dataIndex="alias"
          title={t.alias}
          render={(alias: string, user) => <Link to={`/users/${user.id}`}>{alias}</Link>}
        />
        <Table.Column<AdminUserDto>
          dataIndex="channel"
          title={t.channel}
          render={(channel: AdminUserDto['channel']) => texts.channels[channel]}
        />
        <Table.Column<AdminUserDto>
          key="kind"
          title={t.kind}
          render={(_, user) => <KindTag user={user} />}
        />
        <Table.Column<AdminUserDto> dataIndex="locale" title={t.locale} />
        <Table.Column<AdminUserDto>
          key="receiving"
          title={t.receiving}
          render={(_, user) => <ReceivingTag user={user} />}
        />
        <Table.Column<AdminUserDto> dataIndex="questionsAsked" title={t.asked} align="right" />
        <Table.Column<AdminUserDto> dataIndex="answersGiven" title={t.answered} align="right" />
        <Table.Column<AdminUserDto> dataIndex="lastSeenAt" title={t.lastSeen} render={formatTime} />
        <Table.Column<AdminUserDto> dataIndex="createdAt" title={t.createdAt} render={formatTime} />
      </Table>
    </List>
  );
}
