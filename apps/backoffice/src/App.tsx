import { Authenticated, Refine } from '@refinedev/core';
import { ThemedLayout, useNotificationProvider } from '@refinedev/antd';
import routerProvider, { CatchAllNavigate, NavigateToResource } from '@refinedev/react-router';
import { App as AntdApp, ConfigProvider } from 'antd';
// The ES build: the default `antd/locale/*` is CommonJS and loses its default export in Vite
import ruRU from 'antd/es/locale/ru_RU';
import dayjs from 'dayjs';
import 'dayjs/locale/ru';
import { BrowserRouter, Outlet, Route, Routes } from 'react-router';
import '@refinedev/antd/dist/reset.css';
import { LoginPage } from './LoginPage';
import { authProvider } from './providers/auth';
import { AdminApiError } from './providers/http';
import { dataProvider } from './providers/data';
import { i18nProvider } from './providers/i18n';
import { texts } from './texts';
import { QuestionList } from './questions/QuestionList';
import { UserList } from './users/UserList';
import { UserShow } from './users/UserShow';

// Month and weekday names of the date pickers
dayjs.locale('ru');

/** The back office is served under /admin, like its API and cookie (`base` in vite.config.ts). */
const BASENAME = '/admin';

export function App() {
  return (
    <BrowserRouter basename={BASENAME}>
      <ConfigProvider locale={ruRU}>
        <AntdApp>
          <Refine
            authProvider={authProvider}
            dataProvider={dataProvider}
            i18nProvider={i18nProvider}
            routerProvider={routerProvider}
            notificationProvider={useNotificationProvider}
            options={{
              syncWithLocation: true,
              disableTelemetry: true,
              reactQuery: {
                clientConfig: {
                  defaultOptions: {
                    queries: {
                      // A refusal (401, 404) is an answer: retrying only delays the page
                      retry: (count, error) =>
                        !(error instanceof AdminApiError && error.status !== 0) && count < 2,
                    },
                  },
                },
              },
            }}
            resources={[
              {
                name: 'users',
                list: '/users',
                show: '/users/:id',
                meta: { label: texts.users.menu },
              },
              {
                name: 'questions',
                list: '/questions',
                meta: { label: texts.questions.menu },
              },
            ]}
          >
            <Routes>
              <Route
                element={
                  <Authenticated key="private" fallback={<CatchAllNavigate to="/login" />}>
                    <ThemedLayout Title={() => <span>{texts.appName}</span>}>
                      <Outlet />
                    </ThemedLayout>
                  </Authenticated>
                }
              >
                <Route index element={<NavigateToResource resource="users" />} />
                <Route path="/users">
                  <Route index element={<UserList />} />
                  <Route path=":id" element={<UserShow />} />
                </Route>
                <Route path="/questions" element={<QuestionList />} />
              </Route>
              <Route
                element={
                  // `loading` keeps the page while a failed sign-in re-checks the session;
                  // otherwise the form is mounted anew and the typed login is lost
                  <Authenticated key="public" fallback={<Outlet />} loading={<Outlet />}>
                    <NavigateToResource />
                  </Authenticated>
                }
              >
                <Route path="/login" element={<LoginPage />} />
              </Route>
            </Routes>
          </Refine>
        </AntdApp>
      </ConfigProvider>
    </BrowserRouter>
  );
}
