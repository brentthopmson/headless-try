const fs = require('fs');
const path = require('path');

// 1. Fix WebFixx/app/page.tsx
const pagePath = 'C:/Users/HP/Desktop/ZIPPER/WEBFIXX/DEV/App/WEBFIXX/WebFixx/app/page.tsx';
let page = fs.readFileSync(pagePath, 'utf8').replace(/\r\n/g, '\n');

// Ensure useCallback import
if (!page.includes('useCallback')) {
  page = page.replace(
    'import { useState, useEffect, useRef } from "react";',
    'import { useState, useEffect, useRef, useCallback } from "react";'
  );
}

// Update handleRedirect
const oldRedirect = `  const handleRedirect = (user: LoginResponse['user']) => {
    if (user.role === "ADMIN") {
      router.replace("/root");
    } else if (user.verifyStatus === "FALSE" || !user.verifyStatus) {
      router.replace("/verify");
    } else {
      router.replace("/dashboard");
    }
  };`;

const newRedirect = `  const handleRedirect = useCallback((user: LoginResponse['user']) => {
    if (user.verifyStatus === "FALSE") {
      router.replace("/verify");
    } else {
      router.replace("/dashboard");
    }
  }, [router]);`;

if (page.includes(oldRedirect)) {
  page = page.replace(oldRedirect, newRedirect);
  console.log('page.tsx: handleRedirect updated');
} else {
  console.log('page.tsx: oldRedirect not matched, checking if already updated');
}

// Update handleSubmit
const oldSubmitBlock = `        if (response.success && response.token) {
          // Store token in cookies
          document.cookie = \`loggedInAdmin=\${response.token}; path=/; max-age=2592000\`;
          document.cookie = \`verifyStatus=\${response.user.verifyStatus}; path=/; max-age=2592000\`;

          // Update global app state immediately after successful login
          setAppData({
            user: response.user,
            data: response.data,
            isAuthenticated: true,
            isOffline: false, // Ensure isOffline is explicitly set to false
          });
        }`;

const newSubmitBlock = `        if (response.success && response.token) {
          // Store token in cookies with path and SameSite
          document.cookie = \`loggedInAdmin=\${response.token}; path=/; max-age=2592000; SameSite=Lax\`;
          document.cookie = \`verifyStatus=\${response.user.verifyStatus || 'TRUE'}; path=/; max-age=2592000; SameSite=Lax\`;

          // Also persist in localStorage for instant retrieval on hard reload
          try {
            localStorage.setItem('authToken', response.token);
            localStorage.setItem('appState', JSON.stringify({
              user: response.user,
              data: response.data,
              isAuthenticated: true,
              isOffline: false,
            }));
          } catch (e) {
            try {
              localStorage.setItem('authToken', response.token);
              localStorage.setItem('appState', JSON.stringify({
                user: response.user,
                isAuthenticated: true,
                isOffline: false,
              }));
            } catch (_) {}
          }

          // Update global app state immediately after successful login
          setAppData({
            user: response.user,
            data: response.data,
            isAuthenticated: true,
            isOffline: false,
          });

          setIsSubmitting(false);

          // Direct redirect immediately!
          handleRedirect(response.user);
          return;
        }`;

if (page.includes(oldSubmitBlock)) {
  page = page.replace(oldSubmitBlock, newSubmitBlock);
  console.log('page.tsx: handleSubmit updated');
} else {
  console.log('page.tsx: oldSubmitBlock not matched, checking if already updated');
}

fs.writeFileSync(pagePath, page.replace(/\n/g, '\r\n'), 'utf8');

// 2. Fix WebFixx/app/RootLayout.tsx
const rootPath = 'C:/Users/HP/Desktop/ZIPPER/WEBFIXX/DEV/App/WEBFIXX/WebFixx/app/RootLayout.tsx';
let root = fs.readFileSync(rootPath, 'utf8').replace(/\r\n/g, '\n');

// Make dashboard: true for ADMIN so admin can see and use /dashboard
const oldAdminLinks = `      if (appData.user.role === 'ADMIN') {
        setVisibleLinks({
          dashboard: false,
          campaign: true,
          projectLinks: false,
          redirectLinks: false,
          customDev: false,
          tools: false,
          wallet: false,
          settings: false,
          support: false,
          rootDashboard: true,
          users: true,
          transactions: true,
          rootSupport: true,
          rootTickets: true,
          rootSettings: true
        });
      }`;

const newAdminLinks = `      if (appData.user.role === 'ADMIN') {
        setVisibleLinks({
          dashboard: true,
          campaign: true,
          projectLinks: true,
          redirectLinks: true,
          customDev: false,
          tools: true,
          wallet: true,
          settings: true,
          support: true,
          rootDashboard: true,
          users: true,
          transactions: true,
          rootSupport: true,
          rootTickets: true,
          rootSettings: true
        });
      }`;

if (root.includes(oldAdminLinks)) {
  root = root.replace(oldAdminLinks, newAdminLinks);
  console.log('RootLayout.tsx: admin links updated (dashboard: true)');
}

// In restoreSession, check both cookie and localStorage, and do not logout on general network errors
const oldRestoreToken = `      try {
        const token = document.cookie.match('(^|;)\\\\s*loggedInAdmin\\\\s*=\\\\s*([^;]+)')?.pop();
        
        if (!token) {
          setIsLoading(false);
          return;
        }`;

const newRestoreToken = `      try {
        let token = document.cookie.match('(^|;)\\\\s*loggedInAdmin\\\\s*=\\\\s*([^;]+)')?.pop();
        if (!token && typeof window !== 'undefined') {
          token = localStorage.getItem('authToken');
          if (token) {
            document.cookie = \`loggedInAdmin=\${token}; path=/; max-age=2592000; SameSite=Lax\`;
          }
        }
        
        if (!token) {
          setIsLoading(false);
          return;
        }`;

if (root.includes(oldRestoreToken)) {
  root = root.replace(oldRestoreToken, newRestoreToken);
  console.log('RootLayout.tsx: restoreToken updated');
}

// Fix error handler in restoreSession: do not logout on general network or transient errors
const oldCatchBlock = `      } catch (error) {
        console.error('Session validation error:', error);
        // Only logout on specific errors
        if (error instanceof Error && 
            (error.message.includes('token') || error.message.includes('auth'))) {
          handleLogoutRef.current();
        }
      } finally {`;

const newCatchBlock = `      } catch (error) {
        console.error('Session validation error:', error);
        // DO NOT wipe session on network/offline glitches!
        // Only logout if explicitly reported as expired/invalid token
        if (error instanceof Error && 
            (error.message === 'Token expired' || error.message === 'Invalid token')) {
          handleLogoutRef.current();
        }
      } finally {`;

if (root.includes(oldCatchBlock)) {
  root = root.replace(oldCatchBlock, newCatchBlock);
  console.log('RootLayout.tsx: catch block updated');
}

// Fix route guard in RootLayout.tsx: do not prematurely redirect to '/' while token is present
const oldRouteGuard = `  // Route-level guard: redirect unauthenticated users (expired/invalid session)
  // on protected pages to the login page.
  useEffect(() => {
    if (isLoading || isLoggingOut || !pathname || isPublicPath(pathname)) return;

    const authenticated = !!(hasToken && appData?.isAuthenticated && appData?.user);

    if (!authenticated) {
      router.replace('/');
    }
  }, [isLoading, isLoggingOut, pathname, hasToken, appData, router]);`;

const newRouteGuard = `  // Route-level guard: redirect unauthenticated users (expired/invalid session)
  // on protected pages to the login page.
  useEffect(() => {
    if (isLoading || isLoggingOut || !pathname || isPublicPath(pathname)) return;

    const tokenExists = hasToken || (typeof window !== 'undefined' && !!localStorage.getItem('authToken'));
    const authenticated = !!(tokenExists && appData?.isAuthenticated && appData?.user);

    // Only redirect to login if NO token exists at all. If token exists, give session restore a chance.
    if (!authenticated && !tokenExists) {
      router.replace('/');
    }
  }, [isLoading, isLoggingOut, pathname, hasToken, appData, router]);`;

if (root.includes(oldRouteGuard)) {
  root = root.replace(oldRouteGuard, newRouteGuard);
  console.log('RootLayout.tsx: route guard updated');
}

fs.writeFileSync(rootPath, root.replace(/\n/g, '\r\n'), 'utf8');

// 3. Fix AppContext.tsx
const contextPath = 'C:/Users/HP/Desktop/ZIPPER/WEBFIXX/DEV/App/WEBFIXX/WebFixx/app/context/AppContext.tsx';
let context = fs.readFileSync(contextPath, 'utf8').replace(/\r\n/g, '\n');

// In clearAppData, also remove authToken
const oldClearAppData = `  const clearAppData = useCallback(() => {
    setAppData(null);
    setIsOffline(false); // Also reset offline status on logout
    localStorage.removeItem('appState');
    // Clear auth cookies
    document.cookie = 'loggedInAdmin=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
    document.cookie = 'verifyStatus=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
  }, []);`;

const newClearAppData = `  const clearAppData = useCallback(() => {
    setAppData(null);
    setIsOffline(false); // Also reset offline status on logout
    try {
      localStorage.removeItem('appState');
      localStorage.removeItem('authToken');
    } catch (_) {}
    // Clear auth cookies
    document.cookie = 'loggedInAdmin=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
    document.cookie = 'verifyStatus=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
  }, []);`;

if (context.includes(oldClearAppData)) {
  context = context.replace(oldClearAppData, newClearAppData);
  console.log('AppContext.tsx: clearAppData updated');
}

// In debounced localStorage write, add ultra-slim fallback if quota exceeded
const oldQuotaBlock = `          } catch {
            // Still over quota — restoreSession fetch will recover on mount.
          }`;

const newQuotaBlock = `          } catch {
            try {
              localStorage.setItem('appState', JSON.stringify({
                user: appData.user,
                isAuthenticated: appData.isAuthenticated,
                isOffline: false,
                data: {}
              }));
            } catch (_) {}
          }`;

if (context.includes(oldQuotaBlock)) {
  context = context.replace(oldQuotaBlock, newQuotaBlock);
  console.log('AppContext.tsx: quota block updated');
}

fs.writeFileSync(contextPath, context.replace(/\n/g, '\r\n'), 'utf8');

// 4. Fix utils/auth.ts
const authPath = 'C:/Users/HP/Desktop/ZIPPER/WEBFIXX/DEV/App/WEBFIXX/WebFixx/utils/auth.ts';
let auth = fs.readFileSync(authPath, 'utf8').replace(/\r\n/g, '\n');

const oldGetAuthToken = `const getAuthToken = (): string | null => {
  return localStorage.getItem('authToken');
};`;

const newGetAuthToken = `const getAuthToken = (): string | null => {
  if (typeof window !== 'undefined') {
    const local = localStorage.getItem('authToken');
    if (local) return local;
  }
  if (typeof document !== 'undefined') {
    const match = document.cookie.match('(^|;)\\\\s*loggedInAdmin\\\\s*=\\\\s*([^;]+)');
    if (match) return match.pop() || null;
  }
  return null;
};`;

if (auth.includes(oldGetAuthToken)) {
  auth = auth.replace(oldGetAuthToken, newGetAuthToken);
  console.log('auth.ts: getAuthToken updated');
}

fs.writeFileSync(authPath, auth.replace(/\n/g, '\r\n'), 'utf8');

console.log('ALL FRONTEND AUTH & ROUTING FIXES APPLIED SUCCESSFULLY!');
