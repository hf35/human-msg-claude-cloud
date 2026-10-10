import { settingsSchema, type SettingsResponse } from '@human-msg/shared';
import { useQuery } from '@tanstack/react-query';
import { http } from './providers/http';

export const SETTINGS_KEY = ['backoffice', 'settings'] as const;

/** The product settings in force and their defaults (`GET /admin/api/settings`). */
export const fetchSettings = async (): Promise<SettingsResponse> => {
  const response = await http<{ settings: unknown; defaults: unknown }>('GET', '/settings');
  return {
    settings: settingsSchema.parse(response.settings),
    defaults: settingsSchema.parse(response.defaults),
  };
};

export const useSettings = () => useQuery({ queryKey: SETTINGS_KEY, queryFn: fetchSettings });
