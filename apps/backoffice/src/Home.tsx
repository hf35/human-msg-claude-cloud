import { Typography } from 'antd';
import { texts } from './texts';

/** The landing page; the sections of the back office are added to the menu as they appear. */
export function Home() {
  return (
    <>
      <Typography.Title level={3}>{texts.home.title}</Typography.Title>
      <Typography.Paragraph>{texts.home.welcome}</Typography.Paragraph>
    </>
  );
}
