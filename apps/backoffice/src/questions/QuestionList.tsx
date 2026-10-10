import type { AdminQuestionDto } from '@human-msg/shared';
import { List, useTable } from '@refinedev/antd';
import type { CrudFilter } from '@refinedev/core';
import { Form, Segmented, Space, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import { Link } from 'react-router';
import { formatTime } from '../format';
import { texts } from '../texts';
import { QuestionDetails } from './QuestionDetails';
import { StatusTag } from './status';

const t = texts.questions;

type Status = AdminQuestionDto['status'] | 'all';
const STATUSES: Status[] = ['all', 'queued', 'assigned', 'answered', 'expired'];

const valueOf = (filters: CrudFilter[], field: string): string | undefined => {
  const found = filters.find((filter) => 'field' in filter && filter.field === field);
  return found?.value === undefined || found.value === '' ? undefined : String(found.value);
};

/** The address of the questions list showing only the questions of one author. */
export const questionsOfAuthor = (authorId: string): string =>
  `/questions?${new URLSearchParams({
    'filters[0][field]': 'authorId',
    'filters[0][operator]': 'eq',
    'filters[0][value]': authorId,
  })}`;

export function QuestionList() {
  const { tableProps, filters, setFilters, searchFormProps } = useTable<
    AdminQuestionDto,
    never,
    { status: Status }
  >({
    syncWithLocation: true,
    sorters: { mode: 'off' },
    // Merged into the filters in force: the author filter stays
    onSearch: ({ status }) => [
      { field: 'status', operator: 'eq', value: status === 'all' ? undefined : status },
    ],
  });
  // Read once: the status of the address the page was opened with
  const [initialStatus] = useState(() => (valueOf(filters, 'status') ?? 'all') as Status);
  const authorId = valueOf(filters, 'authorId');
  const authorAlias = tableProps.dataSource?.[0]?.authorAlias;

  return (
    <List title={t.title}>
      <Space wrap style={{ marginBottom: 16 }}>
        <Form
          {...searchFormProps}
          initialValues={{ status: initialStatus }}
          onValuesChange={() => searchFormProps.form?.submit()}
        >
          <Form.Item name="status" noStyle>
            <Segmented<Status>
              options={STATUSES.map((value) => ({
                value,
                label: value === 'all' ? t.all : texts.questionStatus[value],
              }))}
            />
          </Form.Item>
        </Form>
        {authorId && (
          <Tag
            closable
            onClose={() =>
              setFilters([{ field: 'authorId', operator: 'eq', value: undefined }], 'merge')
            }
          >
            {t.authorFilter}: {authorAlias ?? authorId}
          </Tag>
        )}
      </Space>

      <Table
        {...tableProps}
        rowKey="id"
        scroll={{ x: true }}
        expandable={{
          expandedRowRender: (question) => <QuestionDetails question={question} />,
        }}
      >
        <Table.Column<AdminQuestionDto>
          dataIndex="createdAt"
          title={t.createdAt}
          render={formatTime}
        />
        <Table.Column<AdminQuestionDto>
          dataIndex="status"
          title={t.status}
          render={(value: AdminQuestionDto['status']) => <StatusTag status={value} />}
        />
        <Table.Column<AdminQuestionDto>
          dataIndex="authorAlias"
          title={t.author}
          render={(alias: string, question) => (
            <Link to={`/users/${question.authorId}`}>{alias}</Link>
          )}
        />
        <Table.Column<AdminQuestionDto>
          dataIndex="text"
          title={t.text}
          render={(text: string) => (
            <Typography.Text ellipsis={{ tooltip: text }} style={{ maxWidth: 420 }}>
              {text}
            </Typography.Text>
          )}
        />
        <Table.Column<AdminQuestionDto>
          key="receivers"
          title={t.receivers}
          align="right"
          render={(_, question) => question.assignments.length}
        />
        <Table.Column<AdminQuestionDto>
          key="answer"
          title={t.answer}
          render={(_, question) =>
            question.answer ? (
              <Link to={`/users/${question.answer.responderId}`}>
                {question.answer.responderAlias}
              </Link>
            ) : (
              '—'
            )
          }
        />
      </Table>
    </List>
  );
}
