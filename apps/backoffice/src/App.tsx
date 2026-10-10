import { Authenticated, Refine } from '@refinedev/core';
import { ThemedLayout, useNotificationProvider } from '@refinedev/antd';
import routerProvider, { CatchAllNavigate, NavigateToResource } from '@refinedev/react-router';
import { App as AntdApp, ConfigProvider } from 'antd';
import ruRU from 'antd/locale/ru_RU';
import { BrowserRouter, Outlet, Route, Routes } from 'react-router';
import '@refinedev/antd/dist/reset.css';
import { Home } from './Home';
import { LoginPage } from './LoginPage';
import { authProvider } from './providers/auth';
import { dataProvider } from './providers/data';
import { i18nProvider } from './providers/i18n';
import { texts } from './texts';

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
            options={{ syncWithLocation: true, disableTelemetry: true }}
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
                <Route index element={<Home />} />
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
