import type { CrudFilters, DataProvider } from '@refinedev/core';
import { API_URL, http } from './http';

type Query = Record<string, string | number | boolean>;

/** Only equality filters exist on the server: `field=value` in the query string. */
function toQuery(filters: CrudFilters | undefined): Query {
  const query: Query = {};
  for (const filter of filters ?? []) {
    if (!('field' in filter) || filter.operator !== 'eq') continue;
    if (filter.value === undefined || filter.value === null || filter.value === '') continue;
    query[filter.field] = filter.value as string | number | boolean;
  }
  return query;
}

/**
 * Refine data provider for `/admin/api`. Lists are `{ items, total }` with `limit`/`offset`; the
 * server decides the order, so sorters are not sent. Resources that do not fit the standard
 * methods use `custom`.
 */
export const dataProvider: DataProvider = {
  getApiUrl: () => API_URL,

  async getList({ resource, pagination, filters }) {
    const pageSize = pagination?.pageSize ?? 20;
    const currentPage = pagination?.currentPage ?? 1;
    const data = await http<{ items: never[]; total: number }>('GET', `/${resource}`, {
      query: { ...toQuery(filters), limit: pageSize, offset: (currentPage - 1) * pageSize },
    });
    return { data: data.items, total: data.total };
  },

  async getOne({ resource, id }) {
    return { data: await http('GET', `/${resource}/${encodeURIComponent(String(id))}`) };
  },

  async create({ resource, variables }) {
    return { data: await http('POST', `/${resource}`, { body: variables }) };
  },

  async update({ resource, id, variables }) {
    return {
      data: await http('PUT', `/${resource}/${encodeURIComponent(String(id))}`, {
        body: variables,
      }),
    };
  },

  // Nothing is deleted from the back office: users and questions are history
  deleteOne() {
    return Promise.reject(new Error('Deleting is not supported'));
  },

  async custom({ url, method, payload, query }) {
    const path = url.startsWith(API_URL) ? url.slice(API_URL.length) : url;
    const verb =
      method === 'put' || method === 'post' ? (method.toUpperCase() as 'PUT' | 'POST') : 'GET';
    return {
      data: await http(verb, path, {
        ...(query && { query: query as Query }),
        ...(payload !== undefined && { body: payload }),
      }),
    };
  },
};
