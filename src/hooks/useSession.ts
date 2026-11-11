"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch, type SystemStatus, type UserProfile } from "../lib/api-client";

export function useSession() {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [statusRes, meRes] = await Promise.all([
        apiFetch<SystemStatus>("/api/system/status").catch(() => null),
        apiFetch<{ user: UserProfile }>("/api/auth/me").catch(() => null),
      ]);
      if (statusRes) setSystemStatus(statusRes);
      setUser(meRes ? meRes.user : null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    user,
    setUser,
    systemStatus,
    loading,
    refresh,
  };
}
