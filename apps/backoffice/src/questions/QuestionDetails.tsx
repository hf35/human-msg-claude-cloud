import type { AdminQuestionDto } from '@human-msg/shared';
import { Card, Descriptions, Space, Table, Typography } from 'antd';
import { Link } from 'react-router';
import { formatTime } from '../format';
import { texts } from '../texts';
import { OutcomeTag } from './status';

const t = texts.questions;

type Assignment = AdminQuestionDto['assignments'][number];

/** Everything about one question: its text, the answer and who it was assigned to. */
export function QuestionDetails({ question }: { question: AdminQuestionDto }) {
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
        {question.text}
      </Typography.Paragraph>
      <Descriptions size="small" column={{ xs: 1, md: 3 }}>
        <Descriptions.Item label={t.createdAt}>{formatTime(question.createdAt)}</Descriptions.Item>
        <Descriptions.Item label={t.expiresAt}>{formatTime(question.expiresAt)}</Descriptions.Item>
        <Descriptions.Item label={t.answeredAt}>
          {formatTime(question.answeredAt)}
        </Descriptions.Item>
      </Descriptions>
      {question.answer ? (
        <Card
          size="small"
          type="inner"
          title={
            <>
              {t.answerFrom}{' '}
              <Link to={`/users/${question.answer.responderId}`}>
                {question.answer.responderAlias}
              </Link>{' '}
              · {formatTime(question.answer.createdAt)}
            </>
          }
        >
          <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
            {question.answer.text}
          </Typography.Paragraph>
        </Card>
      ) : (
        <Typography.Text type="secondary">{t.noAnswer}</Typography.Text>
      )}
      <Typography.Text strong>{t.assignments}</Typography.Text>
      <Table<Assignment>
        size="small"
        pagination={false}
        rowKey={(assignment) => `${assignment.receiverId}:${assignment.assignedAt}`}
        dataSource={question.assignments}
        locale={{ emptyText: t.noAssignments }}
        scroll={{ x: true }}
      >
        <Table.Column<Assignment>
          dataIndex="receiverAlias"
          title={t.receiver}
          render={(alias: string, assignment) => (
            <Link to={`/users/${assignment.receiverId}`}>{alias}</Link>
          )}
        />
        <Table.Column<Assignment> dataIndex="assignedAt" title={t.assignedAt} render={formatTime} />
        <Table.Column<Assignment> dataIndex="deadlineAt" title={t.deadlineAt} render={formatTime} />
        <Table.Column<Assignment> dataIndex="endedAt" title={t.endedAt} render={formatTime} />
        <Table.Column<Assignment>
          dataIndex="outcome"
          title={t.outcome}
          render={(outcome: Assignment['outcome']) => <OutcomeTag outcome={outcome} />}
        />
      </Table>
    </Space>
  );
}
