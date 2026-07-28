import { createBrowserRouter } from 'react-router-dom';
import { Layout } from './components/layout/Layout.tsx';
import { HomePage } from './pages/HomePage.tsx';
import { DashboardPage } from './pages/DashboardPage.tsx';
import { ReportsPage } from './pages/ReportsPage.tsx';
import { SectorVersionPage, VersionsIndexPage } from './pages/SectorVersionPage.tsx';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <Layout><HomePage /></Layout>,
  },
  {
    path: '/dashboard/:jobId',
    element: <Layout><DashboardPage /></Layout>,
  },
  {
    path: '/informes',
    element: <Layout><ReportsPage /></Layout>,
  },
  {
    path: '/versiones',
    element: <VersionsIndexPage />,
  },
  {
    path: '/version/:sector',
    element: <SectorVersionPage />,
  },
  {
    path: '/mira/:businessSlug',
    element: <SectorVersionPage />,
  },
  {
    path: '/:businessSlug',
    element: <SectorVersionPage />,
  },
]);
