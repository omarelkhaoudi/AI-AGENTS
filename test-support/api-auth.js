import { buildApi } from "../src/api/server.js";
import { createApiTokenMaterial } from "../src/security/api-token.js";

// Shared test authentication. Tests authenticate exactly like a real client:
// a real User, a real ApiToken, a real Bearer header. There is deliberately no
// way to switch authentication off.
export async function createAuthenticatedUser(repository, {
  id = "test-leader",
  role = "leader",
  name = null,
  status = "active"
} = {}) {
  const user = await repository.upsertUser({
    id,
    name: name ?? id,
    role,
    status
  });
  const material = createApiTokenMaterial({ userId: user.id, name: `${user.id}-token` });
  const token = await repository.createApiToken(material.record);

  return Object.freeze({
    user,
    token,
    secret: material.secret,
    headers: Object.freeze({ authorization: `Bearer ${material.secret}` })
  });
}

export async function buildAuthenticatedApi({
  repository,
  role = "leader",
  userId = "test-leader",
  ...options
} = {}) {
  if (!repository) {
    throw new Error("buildAuthenticatedApi requires an explicit repository.");
  }

  const app = buildApi({ repository, ...options });
  const principal = await createAuthenticatedUser(repository, { id: userId, role });

  return Object.freeze({
    app,
    principal,
    headers: principal.headers,
    inject: (injectOptions = {}) => app.inject({
      ...injectOptions,
      headers: { ...principal.headers, ...(injectOptions.headers ?? {}) }
    })
  });
}
