import {
  parseTimeRange,
  settingsSchema,
  type Settings,
  type SettingsResponse,
} from '@human-msg/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Form,
  Input,
  InputNumber,
  Row,
  Select,
  Space,
  Spin,
  Typography,
} from 'antd';
import { useEffect, useMemo } from 'react';
import { AdminApiError, http } from '../providers/http';
import { errorText, texts } from '../texts';
import { SETTINGS_KEY, useSettings } from './useSettings';

const t = texts.settings;

type Key = keyof Settings;

/** Durations are whole seconds on the server and minutes in the form. */
const DURATIONS = [
  'QUESTION_TTL',
  'ANSWER_TIMEOUT',
  'ANSWER_REMINDER',
  'COOLDOWN_TELEGRAM',
  'COOLDOWN_WEB',
  'COOLDOWN_SKIP',
] as const satisfies Key[];
type Duration = (typeof DURATIONS)[number];
const isDuration = (key: Key): key is Duration => (DURATIONS as readonly Key[]).includes(key);

/** The form's values: like `Settings`, with durations in minutes. */
type FormValues = Record<Key, number | string>;

const toForm = (settings: Settings): FormValues => {
  const values = { ...settings } as FormValues;
  for (const key of DURATIONS) values[key] = settings[key] / 60;
  return values;
};

const fromForm = (values: FormValues): Record<string, unknown> => {
  const settings: Record<string, unknown> = { ...values };
  for (const key of DURATIONS) settings[key] = Math.round(Number(values[key]) * 60);
  return settings;
};

/** How a value reads next to "by default". */
const show = (key: Key, value: Settings[Key]): string =>
  isDuration(key) ? `${Number(value) / 60} ${t.minutes}` : String(value);

const GROUPS: { title: string; keys: Key[] }[] = [
  { title: t.groups.time, keys: ['QUESTION_TTL', 'ANSWER_TIMEOUT', 'ANSWER_REMINDER'] },
  { title: t.groups.cooldowns, keys: ['COOLDOWN_TELEGRAM', 'COOLDOWN_WEB', 'COOLDOWN_SKIP'] },
  {
    title: t.groups.telegram,
    keys: ['QUIET_HOURS', 'QUIET_HOURS_TZ', 'AUTO_DND_AFTER_MISSED'],
  },
  { title: t.groups.limits, keys: ['QUESTIONS_PER_DAY', 'MESSAGE_MAX_LENGTH'] },
];

/** Bounds of the number inputs; the schema in `shared` is the final judge. */
const MIN: Partial<Record<Key, number>> = {
  QUESTION_TTL: 1 / 60,
  ANSWER_TIMEOUT: 1 / 60,
  ANSWER_REMINDER: 1 / 60,
  COOLDOWN_TELEGRAM: 0,
  COOLDOWN_WEB: 0,
  COOLDOWN_SKIP: 0,
  AUTO_DND_AFTER_MISSED: 0,
  QUESTIONS_PER_DAY: 1,
  MESSAGE_MAX_LENGTH: 2,
};

const timeZones = (): string[] => {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [];
  }
};

/** The message of the first problem the shared schema finds with one setting. */
function problemOf(key: Key, all: FormValues): string | null {
  if (key === 'QUIET_HOURS') {
    try {
      parseTimeRange(String(all.QUIET_HOURS));
    } catch {
      return t.invalid.quietHours;
    }
  }
  const parsed = settingsSchema.safeParse(fromForm(all));
  if (parsed.success) return null;
  const issue = parsed.error.issues.find((candidate) => candidate.path[0] === key);
  if (!issue) return null;
  if (key === 'ANSWER_REMINDER' && issue.code === 'custom') return t.invalid.reminder;
  if (key === 'QUIET_HOURS_TZ') return t.invalid.timeZone;
  return t.invalid.number;
}

function Field({ name, settings }: { name: Key; settings: SettingsResponse }) {
  const form = Form.useFormInstance<FormValues>();
  const [label, help] = t.fields[name];
  const defaultValue = settings.defaults[name];

  const input = isDuration(name) ? (
    <InputNumber
      min={MIN[name]}
      step={1}
      suffix={t.minutes}
      style={{ width: '100%' }}
      aria-label={label}
    />
  ) : name === 'QUIET_HOURS_TZ' ? (
    <Select
      showSearch
      aria-label={label}
      options={timeZones().map((zone) => ({ value: zone, label: zone }))}
    />
  ) : name === 'QUIET_HOURS' ? (
    <Input placeholder="23:00-09:00" aria-label={label} />
  ) : (
    <InputNumber min={MIN[name]} precision={0} style={{ width: '100%' }} aria-label={label} />
  );

  return (
    <Form.Item
      label={label}
      tooltip={help}
      extra={
        <Space size={4}>
          <span>
            {t.default}: {show(name, defaultValue)}
          </span>
          <Typography.Link
            onClick={() =>
              form.setFields([
                { name, value: isDuration(name) ? Number(defaultValue) / 60 : defaultValue },
              ])
            }
          >
            {t.useDefault}
          </Typography.Link>
        </Space>
      }
      name={name}
      // The reminder depends on the deadline: checked again when either changes
      dependencies={name === 'ANSWER_REMINDER' ? ['ANSWER_TIMEOUT'] : []}
      rules={[
        { required: true, message: t.invalid.number },
        ({ getFieldsValue }) => ({
          validator: async () => {
            const problem = problemOf(name, getFieldsValue(true) as FormValues);
            if (problem) throw new Error(problem);
          },
        }),
      ]}
    >
      {input}
    </Form.Item>
  );
}

/** Every product setting in one form; only what changed is sent. */
export function SettingsPage() {
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const [form] = Form.useForm<FormValues>();
  const settings = useSettings();
  const initial = useMemo(
    () => (settings.data ? toForm(settings.data.settings) : null),
    [settings.data],
  );

  useEffect(() => {
    if (initial) form.setFieldsValue(initial);
  }, [form, initial]);

  const save = useMutation({
    mutationFn: (changes: Record<string, unknown>) =>
      http<SettingsResponse>('PUT', '/settings', { body: changes }),
    onSuccess: (response) => {
      queryClient.setQueryData(SETTINGS_KEY, response);
      message.success(t.saved);
    },
    onError: (error) =>
      message.error(errorText(error instanceof AdminApiError ? error.code : 'unknown')),
  });

  const submit = (values: FormValues) => {
    if (!settings.data) return;
    const next = fromForm(values);
    const changes = Object.fromEntries(
      Object.entries(next).filter(([key, value]) => settings.data.settings[key as Key] !== value),
    );
    if (Object.keys(changes).length === 0) {
      message.info(t.nothingChanged);
      return;
    }
    save.mutate(changes);
  };

  if (settings.isPending) return <Spin />;
  if (settings.isError) {
    return (
      <Alert
        type="error"
        message={errorText(settings.error instanceof AdminApiError ? settings.error.code : '')}
      />
    );
  }

  return (
    <>
      <Typography.Title level={3}>{t.title}</Typography.Title>
      <Alert type="info" showIcon message={t.hint} style={{ marginBottom: 16 }} />
      <Form<FormValues>
        form={form}
        layout="vertical"
        initialValues={initial ?? undefined}
        onFinish={submit}
      >
        <Row gutter={[16, 16]}>
          {GROUPS.map((group) => (
            <Col key={group.title} xs={24} lg={12}>
              <Card title={group.title} size="small" style={{ height: '100%' }}>
                {group.keys.map((key) => (
                  <Field key={key} name={key} settings={settings.data} />
                ))}
              </Card>
            </Col>
          ))}
        </Row>
        <Space style={{ marginTop: 16 }}>
          <Button type="primary" htmlType="submit" loading={save.isPending}>
            {t.save}
          </Button>
          <Button onClick={() => initial && form.setFieldsValue(initial)}>{t.reset}</Button>
        </Space>
      </Form>
    </>
  );
}
