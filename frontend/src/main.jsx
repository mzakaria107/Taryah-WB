import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { AuthProvider } from './context/AuthContext';
import { PermissionsProvider } from './context/PermissionsContext';
import { DashboardSettingsProvider } from './context/DashboardSettingsContext';
import { SidebarOrderProvider } from './context/SidebarOrderContext';
import { ToastProvider } from './components/UI/Toast';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <PermissionsProvider>
            <SidebarOrderProvider>
              <DashboardSettingsProvider>
                <ToastProvider>
                  <App />
                </ToastProvider>
              </DashboardSettingsProvider>
            </SidebarOrderProvider>
          </PermissionsProvider>
        </AuthProvider>
      </QueryClientProvider>
    </BrowserRouter>
  </React.StrictMode>
);
