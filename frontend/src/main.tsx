import React, { Suspense, lazy, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';

import './theme.css';
import Home from './pages/Home';
import { useMissionWatcher } from './useMissionWatcher';

const Settings = lazy(() => import('./pages/Settings'));
const Contacts = lazy(() => import('./pages/Contacts'));
const History = lazy(() => import('./pages/History'));
const MissionStatus = lazy(() => import('./pages/MissionStatus'));

document.documentElement.dataset.theme =
  (() => {
    try {
      return localStorage.getItem('apa.theme.v1') === 'dark' ? 'dark' : 'light';
    } catch {
      return 'light';
    }
  })();

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

function CallWatcher() {
  useMissionWatcher();
  return null;
}

function App() {
  return (
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <ScrollToTop />
      <CallWatcher />
      <Suspense fallback={<div className="content" />}>
        <Routes>
          <Route path="/home" element={<Home />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/contacts" element={<Contacts />} />
          <Route path="/history" element={<History />} />
          <Route path="/missions/:id" element={<MissionStatus />} />
          <Route path="*" element={<Navigate to="/home" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
