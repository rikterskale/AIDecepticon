import crypto from 'node:crypto';
import { defaultOrganizationId } from './seed.js';

const organizationIdPattern = /^org-[a-zA-Z0-9._-]{2,60}$/;

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  return value === undefined || value === null ? [] : [String(value)];
}

export function normalizeOrganizationIds(value, fallback = []) {
  const ids = [...new Set(normalizeList(value))];
  if (ids.includes('*')) return ['*'];
  const invalid = ids.find((id) => !organizationIdPattern.test(id));
  if (invalid) throw new Error(`Invalid organization ID ${invalid}`);
  return ids.length ? ids : [...fallback];
}

export function canAccessOrganization(user, organizationId) {
  if (!user || !organizationId) return false;
  if (user.role === 'platform_admin') return true;
  const ids = normalizeOrganizationIds(user.organizationIds || []);
  return ids.includes('*') || ids.includes(organizationId);
}

export function hasPlatformScope(user) {
  return Boolean(user) && (user.role === 'platform_admin' || normalizeOrganizationIds(user.organizationIds || []).includes('*'));
}

export function organizationScope(request) {
  if (!request.organization?.id) throw new Error('An active organization is required');
  return { organizationId: request.organization.id };
}

export class TenancyController {
  constructor(store, environment = process.env) {
    this.store = store;
    this.defaultOrganizationId = environment.AUTH_DEFAULT_ORGANIZATION_ID || defaultOrganizationId;
    if (!organizationIdPattern.test(this.defaultOrganizationId)) {
      throw new Error('AUTH_DEFAULT_ORGANIZATION_ID must be a valid organization ID');
    }
  }

  async accessibleOrganizations(user) {
    const organizations = await this.store.read('organizations');
    return organizations.filter((organization) => canAccessOrganization(user, organization.id));
  }

  middleware() {
    return async (request, response, next) => {
      if (!request.user || !request.path.startsWith('/api/v1/')) return next();
      try {
        const organizations = await this.accessibleOrganizations(request.user);
        if (!organizations.length) return response.status(403).json({ error: 'Identity has no assigned AIDecepticon organizations' });

        const requestedId = String(request.get('x-aidecepticon-organization') || '').trim();
        if (requestedId && !organizationIdPattern.test(requestedId)) {
          return response.status(400).json({ error: 'X-AIDecepticon-Organization is invalid' });
        }
        const selected = requestedId
          ? organizations.find((organization) => organization.id === requestedId)
          : organizations.find((organization) => organization.id === this.defaultOrganizationId) || organizations[0];
        if (!selected) return response.status(403).json({ error: 'Identity is not authorized for the requested organization' });

        request.organization = selected;
        response.set('X-AIDecepticon-Organization', selected.id);
        next();
      } catch (error) {
        next(error);
      }
    };
  }

  install(app, requirePermission) {
    app.use(this.middleware());

    app.get('/api/v1/organizations', requirePermission('organization:read'), async (request, response) => {
      response.json({
        items: await this.accessibleOrganizations(request.user),
        activeOrganizationId: request.organization.id,
      });
    });

    app.post('/api/v1/organizations', requirePermission('organization:write'), async (request, response) => {
      if (!hasPlatformScope(request.user)) {
        return response.status(403).json({ error: 'Organization creation requires platform-wide scope' });
      }
      const name = String(request.body?.name || '').trim();
      const plan = String(request.body?.plan || 'enterprise');
      const slug = String(request.body?.slug || name).trim().toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 63);
      if (!name || !slug) return response.status(400).json({ error: 'name is required' });
      if (!['managed', 'enterprise', 'evaluation'].includes(plan)) return response.status(400).json({ error: 'plan is unsupported' });
      const organizations = await this.store.read('organizations');
      if (organizations.some((organization) => organization.slug === slug)) {
        return response.status(409).json({ error: 'An organization with this slug already exists' });
      }
      const organization = await this.store.add('organizations', {
        id: `org-${crypto.randomUUID().slice(0, 12)}`,
        name: name.slice(0, 100),
        slug,
        status: 'active',
        plan,
        createdAt: new Date().toISOString(),
        createdBy: request.user.id,
      });
      response.locals.auditTargetId = organization.id;
      response.locals.auditTargetType = 'organization';
      response.locals.auditOrganizationId = organization.id;
      response.status(201).json(organization);
    });
  }
}

export function createTenancyController(store, environment = process.env) {
  return new TenancyController(store, environment);
}

export { defaultOrganizationId };
