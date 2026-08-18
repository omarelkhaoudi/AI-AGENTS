import {
  BUSINESS_DOMAINS,
  normalizeBusinessDomain,
  validateDomain
} from "../business-memory/domain-contract.js";
import {
  BUSINESS_DATA_PROVIDERS,
  BUSINESS_DATA_SOURCES
} from "../business-memory/source.js";
import {
  createBusinessProviderDescriptor,
  validateBusinessProviderDescriptor
} from "../business-memory/business-provider-contract.js";

export const INTEGRATION_PROVIDER_TYPES = Object.freeze({
  CRM: "crm",
  ACCOUNTING: "accounting",
  ERP: "erp",
  PURCHASING: "purchasing",
  HR: "hr",
  AFTER_SALES: "after_sales",
  MARKETING_COMMUNITY: "marketing_community",
  DOCUMENTS_LEGAL: "documents_legal"
});

export const INTEGRATION_OPERATION_STAGES = Object.freeze({
  READ: "read",
  ANALYZE: "analyze",
  PREPARE: "prepare",
  APPROVAL: "approval",
  EXECUTE: "execute"
});

export const INTEGRATION_OPERATION_BOUNDARIES = Object.freeze({
  read: createOperationBoundary({
    stage: "read",
    permissionKind: "read_analyze",
    allowedInPhase0: true,
    requiresHumanApproval: false,
    allowsProviderWrite: false,
    allowsExternalExecution: false
  }),
  analyze: createOperationBoundary({
    stage: "analyze",
    permissionKind: "read_analyze",
    allowedInPhase0: true,
    requiresHumanApproval: false,
    allowsProviderWrite: false,
    allowsExternalExecution: false
  }),
  prepare: createOperationBoundary({
    stage: "prepare",
    permissionKind: "prepare_action",
    allowedInPhase0: true,
    requiresHumanApproval: false,
    allowsProviderWrite: false,
    allowsExternalExecution: false
  }),
  approval: createOperationBoundary({
    stage: "approval",
    permissionKind: "human_approval_required",
    allowedInPhase0: true,
    requiresHumanApproval: true,
    allowsProviderWrite: false,
    allowsExternalExecution: false
  }),
  execute: createOperationBoundary({
    stage: "execute",
    permissionKind: "execute_action",
    allowedInPhase0: false,
    requiresHumanApproval: true,
    allowsProviderWrite: false,
    allowsExternalExecution: false
  })
});

export const INTEGRATION_PROVIDER_PROFILES = Object.freeze({
  crm: createProviderProfile({
    id: "crm",
    label: "Future CRM provider",
    integrationAreas: ["clients", "prospects", "quotes", "orders"],
    supportedDomains: ["customers", "quotes", "orders"]
  }),
  accounting: createProviderProfile({
    id: "accounting",
    label: "Future accounting provider",
    integrationAreas: ["invoices", "payments", "receivables"],
    supportedDomains: ["customers", "invoices", "payments"]
  }),
  erp: createProviderProfile({
    id: "erp",
    label: "Future ERP provider",
    integrationAreas: ["orders", "production"],
    supportedDomains: ["orders", "production"]
  }),
  purchasing: createProviderProfile({
    id: "purchasing",
    label: "Future purchasing provider",
    integrationAreas: ["purchase_needs", "suppliers", "stock"],
    supportedDomains: ["orders", "purchase_needs", "suppliers"]
  }),
  hr: createProviderProfile({
    id: "hr",
    label: "Future HR provider",
    integrationAreas: ["hr"],
    supportedDomains: ["hr_demo_overview"]
  }),
  after_sales: createProviderProfile({
    id: "after_sales",
    label: "Future after-sales provider",
    integrationAreas: ["support", "after_sales", "quality", "customers", "orders"],
    supportedDomains: ["after_sales_tickets", "customers", "orders"]
  }),
  marketing_community: createProviderProfile({
    id: "marketing_community",
    label: "Future marketing and community provider",
    integrationAreas: ["campaigns", "content", "community"],
    supportedDomains: []
  }),
  documents_legal: createProviderProfile({
    id: "documents_legal",
    label: "Future documents and legal provider",
    integrationAreas: ["contracts", "legal_documents", "commercial_terms"],
    supportedDomains: ["customers"]
  })
});

export const AGENT_PROVIDER_DOMAIN_ACCESS = Object.freeze({
  commercial: createAgentProviderAccess(["customers", "quotes", "orders"]),
  finance: createAgentProviderAccess(["invoices", "payments", "customers"]),
  production: createAgentProviderAccess(["orders", "production"]),
  purchasing: createAgentProviderAccess(["orders", "purchase_needs", "suppliers"]),
  hr: createAgentProviderAccess(["hr_demo_overview"]),
  marketing: createAgentProviderAccess([], { integrationAreas: ["campaigns", "content"] }),
  community_manager: createAgentProviderAccess([], {
    supervisorAgentId: "marketing",
    integrationAreas: ["content", "community"]
  }),
  legal: createAgentProviderAccess(["customers"], { integrationAreas: ["contracts", "legal_documents"] }),
  after_sales: createAgentProviderAccess(["after_sales_tickets", "customers", "orders"]),
  director: createAgentProviderAccess([], { orchestratorOnly: true })
});

export class BusinessIntegrationContractError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "BusinessIntegrationContractError";
    this.code = code;
    this.details = details;
  }
}

export function listIntegrationProviderProfiles() {
  return Object.values(INTEGRATION_PROVIDER_PROFILES);
}

export function createFutureProviderDescriptorForProfile({ profileId, sourceId = null } = {}) {
  const profile = requireProviderProfile(profileId);
  return createBusinessProviderDescriptor({
    provider: BUSINESS_DATA_PROVIDERS.FUTURE_REAL_DATA,
    sourceId: sourceId ?? profile.id,
    label: profile.label,
    supportedDomains: profile.supportedDomains,
    capabilities: {
      readRecords: true,
      pagination: true,
      incrementalSync: true,
      writeRecords: false
    },
    connectionStatus: "offline_not_connected"
  });
}

export function assertIntegrationProviderDescriptor(descriptor) {
  validateBusinessProviderDescriptor(descriptor);
  if (descriptor.provider !== BUSINESS_DATA_PROVIDERS.FUTURE_REAL_DATA) {
    throw new BusinessIntegrationContractError(
      "Integration provider descriptors must use future_real_data in Phase 0.",
      "INVALID_INTEGRATION_PROVIDER_SOURCE",
      { provider: descriptor.provider }
    );
  }
  if (descriptor.recordSource !== BUSINESS_DATA_SOURCES.FUTURE_REAL_DATA) {
    throw new BusinessIntegrationContractError(
      "Integration provider records must remain separated from demo_mock.",
      "INVALID_INTEGRATION_RECORD_SOURCE",
      { recordSource: descriptor.recordSource }
    );
  }
  if (descriptor.externalConnectionsEnabled !== false) {
    throw new BusinessIntegrationContractError(
      "External provider connections are disabled in Phase 0.",
      "EXTERNAL_PROVIDER_CONNECTION_FORBIDDEN"
    );
  }
  if (descriptor.capabilities.writeRecords !== false) {
    throw new BusinessIntegrationContractError(
      "Provider write capabilities are disabled in Phase 0.",
      "PROVIDER_WRITE_FORBIDDEN"
    );
  }
  return true;
}

export function validateAgentProviderDomainAccess({ agentId, domain } = {}) {
  const access = AGENT_PROVIDER_DOMAIN_ACCESS[agentId];
  if (!access) {
    throw new BusinessIntegrationContractError("Unknown integration agent.", "UNKNOWN_INTEGRATION_AGENT", {
      agentId
    });
  }
  const normalizedDomain = normalizeKnownIntegrationDomain(domain);
  if (!access.domains.includes(normalizedDomain)) {
    throw new BusinessIntegrationContractError(
      "Agent is not allowed to read this provider domain.",
      "INTEGRATION_DOMAIN_ACCESS_DENIED",
      {
        agentId,
        domain: normalizedDomain,
        allowedDomains: access.domains
      }
    );
  }
  return true;
}

export function validateIntegrationOperation({ stage, descriptor = null } = {}) {
  const boundary = INTEGRATION_OPERATION_BOUNDARIES[stage];
  if (!boundary) {
    throw new BusinessIntegrationContractError("Unknown integration operation stage.", "UNKNOWN_INTEGRATION_STAGE", {
      stage
    });
  }
  if (descriptor) {
    assertIntegrationProviderDescriptor(descriptor);
  }
  if (boundary.allowedInPhase0 !== true) {
    throw new BusinessIntegrationContractError(
      "Real execution is disabled until a real provider is explicitly implemented after Phase 0.",
      "REAL_EXECUTION_DISABLED",
      { stage }
    );
  }
  return boundary;
}

function createProviderProfile({ id, label, integrationAreas, supportedDomains }) {
  if (!Object.values(INTEGRATION_PROVIDER_TYPES).includes(id)) {
    throw new BusinessIntegrationContractError("Unknown integration provider profile.", "UNKNOWN_PROVIDER_PROFILE", {
      id
    });
  }
  return Object.freeze({
    id,
    label,
    integrationAreas: Object.freeze([...integrationAreas]),
    supportedDomains: Object.freeze(supportedDomains.map((domain) => normalizeKnownIntegrationDomain(domain))),
    interchangeable: true,
    externalConnectionsEnabled: false
  });
}

function createAgentProviderAccess(domains, {
  supervisorAgentId = null,
  orchestratorOnly = false,
  integrationAreas = []
} = {}) {
  return Object.freeze({
    domains: Object.freeze(domains.map((domain) => normalizeKnownIntegrationDomain(domain))),
    supervisorAgentId,
    orchestratorOnly,
    integrationAreas: Object.freeze([...integrationAreas])
  });
}

function createOperationBoundary({
  stage,
  permissionKind,
  allowedInPhase0,
  requiresHumanApproval,
  allowsProviderWrite,
  allowsExternalExecution
}) {
  return Object.freeze({
    stage,
    permissionKind,
    allowedInPhase0,
    requiresHumanApproval,
    allowsProviderWrite,
    allowsExternalExecution
  });
}

function requireProviderProfile(profileId) {
  const profile = INTEGRATION_PROVIDER_PROFILES[profileId];
  if (!profile) {
    throw new BusinessIntegrationContractError("Unknown integration provider profile.", "UNKNOWN_PROVIDER_PROFILE", {
      profileId
    });
  }
  return profile;
}

function normalizeKnownIntegrationDomain(domain) {
  const normalizedDomain = normalizeBusinessDomain(domain);
  validateDomain(normalizedDomain);
  if (!BUSINESS_DOMAINS.includes(normalizedDomain)) {
    throw new BusinessIntegrationContractError("Unsupported integration domain.", "UNKNOWN_INTEGRATION_DOMAIN", {
      domain
    });
  }
  return normalizedDomain;
}
