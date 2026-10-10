import { useLogin } from '@refinedev/core';
import { Button, Card, Form, Input, Typography } from 'antd';
import { texts } from './texts';

interface Credentials {
  login: string;
  password: string;
}

export function LoginPage() {
  const { mutate: signIn, isPending } = useLogin<Credentials>();

  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', padding: 16 }}>
      <Card style={{ width: 360, maxWidth: '100%' }}>
        <Typography.Title level={3} style={{ marginTop: 0 }}>
          {texts.login.title}
        </Typography.Title>
        <Form<Credentials> layout="vertical" onFinish={(values) => signIn(values)}>
          <Form.Item
            name="login"
            label={texts.login.login}
            rules={[{ required: true, message: texts.login.required }]}
          >
            <Input autoComplete="username" autoFocus />
          </Form.Item>
          <Form.Item
            name="password"
            label={texts.login.password}
            rules={[{ required: true, message: texts.login.required }]}
          >
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={isPending} block>
            {texts.login.submit}
          </Button>
        </Form>
      </Card>
    </div>
  );
}
