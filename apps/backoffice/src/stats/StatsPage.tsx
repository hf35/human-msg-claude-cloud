import { adminStatsSchema, type AdminStatsDto } from '@human-msg/shared';
import { useQuery } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Card,
  Col,
  Progress,
  Row,
  Segmented,
  Space,
  Spin,
  Statistic,
  Switch,
  Typography,
} from 'antd';
import { useState } from 'react';
import { AdminApiError, http } from '../providers/http';
import { errorText, texts } from '../texts';

const t = texts.stats;

type Period = keyof typeof t.periods;
const PERIOD_MS: Record<Period, number | null> = {
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
  all: null,
};

/** `1 ч 5 мин`, `12 мин`, `40 с`; a dash when there is nothing to average. */
export function formatDuration(seconds: number | null): string {
  if (seconds === null) return t.noData;
  const total = Math.round(seconds);
  if (total < 60) return `${total} ${t.seconds}`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.round((total % 3600) / 60);
  return hours > 0 ? `${hours} ${t.hours} ${minutes} ${t.minutes}` : `${minutes} ${t.minutes}`;
}

const percent = (share: number | null) => (share === null ? null : Math.round(share * 1000) / 10);

function Numbers({ stats }: { stats: AdminStatsDto }) {
  const { questions, assignments } = stats;
  const expired = percent(questions.expiredShare);
  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} xl={6}>
          <Card>
            <Statistic
              title={<span title={t.expiredShareHint}>{t.expiredShare}</span>}
              value={expired ?? t.noData}
              suffix={expired === null ? undefined : '%'}
              // The main goal of the product: every question gets an answer
              valueStyle={{ color: expired !== null && expired > 0 ? '#cf1322' : undefined }}
            />
            <Typography.Text type="secondary">
              {questions.expired} / {questions.answered + questions.expired}
            </Typography.Text>
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card>
            <Statistic
              title={<span title={t.averageToAnswerHint}>{t.averageToAnswer}</span>}
              value={formatDuration(stats.averageSecondsToAnswer)}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card>
            <Statistic title={t.queue} value={stats.queueSize} />
          </Card>
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <Card>
            <Statistic title={t.complaints} value={stats.complaints} />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card title={t.questions} size="small" style={{ height: '100%' }}>
            <Row gutter={[16, 16]}>
              <Col span={8}>
                <Statistic title={t.total} value={questions.total} />
              </Col>
              <Col span={8}>
                <Statistic title={t.byStatus.answered} value={questions.answered} />
              </Col>
              <Col span={8}>
                <Statistic title={t.byStatus.expired} value={questions.expired} />
              </Col>
              <Col span={8}>
                <Statistic title={t.byStatus.queued} value={questions.queued} />
              </Col>
              <Col span={8}>
                <Statistic title={t.byStatus.assigned} value={questions.assigned} />
              </Col>
              <Col span={8}>
                <Statistic title={t.answeredByStaff} value={questions.answeredByStaff} />
              </Col>
            </Row>
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card
            title={<span title={t.assignmentsHint}>{t.assignments}</span>}
            size="small"
            style={{ height: '100%' }}
          >
            <Statistic title={t.total} value={assignments.total} />
            {(
              [
                ['answered', 'green'],
                ['skipped', 'gold'],
                ['timedOut', 'orange'],
                ['reported', 'red'],
                ['undeliverable', 'magenta'],
                ['active', 'blue'],
              ] as const
            ).map(([key, color]) => (
              <Row key={key} align="middle" gutter={8} style={{ marginTop: 8 }}>
                <Col flex="140px">{t[key]}</Col>
                <Col flex="auto">
                  <Progress
                    percent={assignments.total ? (assignments[key] / assignments.total) * 100 : 0}
                    strokeColor={color}
                    format={() => assignments[key]}
                    aria-label={t[key]}
                  />
                </Col>
              </Row>
            ))}
          </Card>
        </Col>
      </Row>
    </Space>
  );
}

/** The numbers the time settings are tuned by. */
export function StatsPage() {
  const [period, setPeriod] = useState<Period>('week');
  const [includeTest, setIncludeTest] = useState(false);

  const stats = useQuery({
    queryKey: ['backoffice', 'stats', period, includeTest],
    queryFn: async () => {
      const span = PERIOD_MS[period];
      return adminStatsSchema.parse(
        await http('GET', '/stats', {
          query: {
            ...(span !== null && { from: new Date(Date.now() - span).toISOString() }),
            ...(includeTest && { includeTest: true }),
          },
        }),
      );
    },
  });

  return (
    <>
      <Space wrap align="center" style={{ width: '100%', justifyContent: 'space-between' }}>
        <Typography.Title level={3} style={{ margin: 0 }}>
          {t.title}
        </Typography.Title>
        <Space wrap>
          <Segmented<Period>
            aria-label={t.period}
            value={period}
            onChange={setPeriod}
            options={(Object.keys(t.periods) as Period[]).map((value) => ({
              value,
              label: t.periods[value],
            }))}
          />
          <Space>
            <Switch aria-label={t.includeTest} checked={includeTest} onChange={setIncludeTest} />
            {t.includeTest}
          </Space>
          <Button onClick={() => stats.refetch()} loading={stats.isFetching}>
            {texts.refresh}
          </Button>
        </Space>
      </Space>
      <Typography.Paragraph type="secondary" style={{ marginTop: 8 }}>
        {t.periodHint}
      </Typography.Paragraph>
      {stats.isPending && <Spin />}
      {stats.isError && (
        <Alert
          type="error"
          message={errorText(stats.error instanceof AdminApiError ? stats.error.code : '')}
        />
      )}
      {stats.isSuccess && <Numbers stats={stats.data} />}
    </>
  );
}
