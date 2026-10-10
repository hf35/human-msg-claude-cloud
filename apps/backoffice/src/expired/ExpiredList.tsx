import type { AdminQuestionDto } from '@human-msg/shared';
import { List } from '@refinedev/antd';
import { useTable } from '@refinedev/core';
import { Alert, Button, Table, Typography } from 'antd';
import { useState } from 'react';
import { Link } from 'react-router';
import { formatTime } from '../format';
import { QuestionDetails } from '../questions/QuestionDetails';
import { texts } from '../texts';
import { AnswerModal } from './AnswerModal';

const t = texts.expired;

/** The journal of questions nobody answered in time, each with a way to answer it. */
export function ExpiredList() {
  // The core hook: the journal has no search form (antd's `useTable` would create an unused one)
  const { tableQuery, currentPage, setCurrentPage, pageSize, setPageSize } =
    useTable<AdminQuestionDto>({
      resource: 'questions',
      syncWithLocation: true,
      sorters: { mode: 'off' },
      filters: { permanent: [{ field: 'status', operator: 'eq', value: 'expired' }] },
    });
  const [answering, setAnswering] = useState<AdminQuestionDto | null>(null);

  return (
    <List title={t.title}>
      <Alert type="info" showIcon message={t.hint} style={{ marginBottom: 16 }} />
      <Table
        dataSource={tableQuery.data?.data}
        loading={tableQuery.isFetching}
        pagination={{
          current: currentPage,
          pageSize,
          total: tableQuery.data?.total,
          onChange: (page, size) => {
            setCurrentPage(page);
            setPageSize(size);
          },
        }}
        rowKey="id"
        scroll={{ x: true }}
        locale={{ emptyText: t.empty }}
        expandable={{
          expandedRowRender: (question) => <QuestionDetails question={question} />,
        }}
      >
        <Table.Column<AdminQuestionDto>
          dataIndex="createdAt"
          title={texts.questions.createdAt}
          render={formatTime}
        />
        <Table.Column<AdminQuestionDto>
          dataIndex="expiresAt"
          title={t.expiredAt}
          render={formatTime}
        />
        <Table.Column<AdminQuestionDto>
          dataIndex="authorAlias"
          title={texts.questions.author}
          render={(alias: string, question) => (
            <Link to={`/users/${question.authorId}`}>{alias}</Link>
          )}
        />
        <Table.Column<AdminQuestionDto>
          dataIndex="text"
          title={texts.questions.text}
          render={(text: string) => (
            <Typography.Paragraph
              ellipsis={{ rows: 3, expandable: true, symbol: '…' }}
              style={{ whiteSpace: 'pre-wrap', margin: 0, maxWidth: 520 }}
            >
              {text}
            </Typography.Paragraph>
          )}
        />
        <Table.Column<AdminQuestionDto>
          key="receivers"
          title={texts.questions.receivers}
          align="right"
          render={(_, question) => question.assignments.length}
        />
        <Table.Column<AdminQuestionDto>
          key="actions"
          render={(_, question) => (
            <Button type="primary" onClick={() => setAnswering(question)}>
              {t.answer}
            </Button>
          )}
        />
      </Table>
      {answering && (
        <AnswerModal
          question={answering}
          onClose={() => setAnswering(null)}
          onAnswered={() => {
            setAnswering(null);
            void tableQuery.refetch();
          }}
        />
      )}
    </List>
  );
}
