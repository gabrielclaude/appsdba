export const CATEGORIES = {
  'oracle-database': {
    label: 'Oracle Database',
    color: 'bg-red-100 text-red-800',
    description: 'Oracle Database architecture, administration, performance tuning, and best practices.',
  },
  'ebs-suite': {
    label: 'EBS Suite 12',
    color: 'bg-orange-100 text-orange-800',
    description: 'Oracle E-Business Suite 12.x administration, patching, and configuration.',
  },
  'weblogic': {
    label: 'WebLogic',
    color: 'bg-yellow-100 text-yellow-800',
    description: 'WebLogic Server administration, tuning, and integration with Oracle middleware.',
  },
  'golden-gate': {
    label: 'Golden Gate',
    color: 'bg-green-100 text-green-800',
    description: 'Oracle GoldenGate replication, CDC, and real-time data integration.',
  },
  'disaster-recovery': {
    label: 'Disaster Recovery',
    color: 'bg-blue-100 text-blue-800',
    description: 'Oracle Data Guard, physical standby, and disaster recovery strategies.',
  },
  'rac-clusterware': {
    label: 'RAC & Clusterware',
    color: 'bg-purple-100 text-purple-800',
    description: 'Oracle Real Application Clusters, Grid Infrastructure, and ASM.',
  },
  'ebs-isg': {
    label: 'EBS SOA Gateway',
    color: 'bg-pink-100 text-pink-800',
    description: 'Oracle E-Business Suite Integrated SOA Gateway — REST and SOAP service deployment, architecture, and integration patterns.',
  },
  'soa-suite': {
    label: 'SOA Suite',
    color: 'bg-teal-100 text-teal-800',
    description: 'Oracle SOA Suite and Oracle Service Bus — service orchestration, BPEL, mediator, adapters, and OSB proxy/business services.',
  },
  'fusion-middleware': {
    label: 'Fusion Middleware',
    color: 'bg-indigo-100 text-indigo-800',
    description: 'Oracle Fusion Middleware platform — WebLogic, JRF, MDS, OPSS, RCU, patching, and cross-component administration.',
  },
  'linux-admin': {
    label: 'Linux Admin',
    color: 'bg-stone-100 text-stone-800',
    description: 'Linux system administration — performance tuning, storage, networking, kernel parameters, and Oracle workload configuration.',
  },
  'exadata': {
    label: 'Exadata',
    color: 'bg-cyan-100 text-cyan-800',
    description: 'Oracle Exadata Database Machine — architecture, Smart Scan, storage indexes, cell offloading, IORM, patching, and administration.',
  },
  'oracle-google-cloud': {
    label: 'Oracle on Google Cloud',
    color: 'bg-blue-100 text-blue-800',
    description: 'Oracle Database@Google Cloud — deploying, connecting, and managing Oracle workloads natively on GCP infrastructure.',
  },
  'essbase': {
    label: 'Essbase',
    color: 'bg-violet-100 text-violet-800',
    description: 'Oracle Essbase — multidimensional analytics, BSO and ASO cube design, topology, EPM integration, and administration.',
  },
  'identity-management': {
    label: 'Identity Management',
    color: 'bg-rose-100 text-rose-800',
    description: 'Oracle Identity & Access Management — OAM single sign-on, OIM user provisioning, and OID LDAP directory administration.',
  },
  'golden-gate-problems': {
    label: 'GoldenGate: Problems & Solutions',
    color: 'bg-emerald-100 text-emerald-800',
    description: 'Oracle GoldenGate production incident case studies, root cause analysis, and resolution patterns for extract lag, apply errors, and replication failures.',
  },
  'ebs-functional': {
    label: 'EBS Functional',
    color: 'bg-amber-100 text-amber-800',
    description: 'Oracle E-Business Suite functional module troubleshooting — General Ledger, Payables, Receivables, Fixed Assets, and period-close process failures.',
  },
  'postgresql': {
    label: 'PostgreSQL',
    color: 'bg-blue-100 text-blue-800',
    description: 'PostgreSQL administration, architecture, performance tuning, replication, and migration — from installation to production operations.',
  },
  'oracle-ml': {
    label: 'Oracle Machine Learning',
    color: 'bg-sky-100 text-sky-800',
    description: 'Oracle Machine Learning — in-database algorithms, OML4Py, OML4SQL, AutoML, and integration with Oracle Database for predictive analytics.',
  },
  'exalogic': {
    label: 'Exalogic',
    color: 'bg-teal-100 text-teal-800',
    description: 'Oracle Exalogic and Oracle RAC on VMware — engineered middleware systems, WebLogic cluster deployment, InfiniBand architecture, vSphere integration, and production operations.',
  },
  'postgres-ml': {
    label: 'PostgreSQL + ML',
    color: 'bg-fuchsia-100 text-fuchsia-800',
    description: 'Full-stack machine learning with PostgreSQL — pgvector embeddings, semantic search, RAG, Python FastAPI middle tier, and Next.js frontend integration.',
  },
  'appsdba': {
    label: 'AppsDBA',
    color: 'bg-indigo-100 text-indigo-800',
    description: 'Oracle Applications DBA case studies — real-world EBS, ASCP, and middleware incident troubleshooting, root cause analysis, and production problem resolution.',
  },
  'performance-dw': {
    label: 'Performance DW',
    color: 'bg-emerald-100 text-emerald-800',
    description: 'EBS concurrent program performance data warehouse — star schema design, AWR correlation, Python ML pipelines, anomaly detection, and duration regression.',
  },
  'netsuite': {
    label: 'NetSuite',
    color: 'bg-blue-100 text-blue-800',
    description: 'NetSuite ERP configuration, administration, and best practices — COA design, item master setup, workflow automation, role-based security, and implementation sequencing.',
  },
  'fusion-cloud-erp': {
    label: 'Fusion Cloud ERP',
    color: 'bg-red-100 text-red-800',
    description: 'Oracle Fusion Cloud ERP — Financials, Procurement, and Supply Chain Cloud configuration, migration, FBDI data loading, Subledger Accounting, and implementation best practices.',
  },
  'oracle-security': {
    label: 'EBS Security',
    color: 'bg-slate-100 text-slate-800',
    description: 'Oracle EBS and database security — exposed endpoint mitigation, CVE virtual patching at the network layer, Critical Patch Updates, OPatch, audit configuration, and hardening for externally accessible EBS web tiers.',
  },
  'ebs-workflow': {
    label: 'EBS Workflow',
    color: 'bg-orange-100 text-orange-800',
    description: 'Oracle E-Business Suite Workflow — Notification Mailer configuration, TLS/STARTTLS troubleshooting, WF_MAILER tuning, and business event system administration.',
  },
  'oracle-retail': {
    label: 'Oracle Retail',
    color: 'bg-cyan-100 text-cyan-800',
    description: 'Oracle Retail suite — ORPOS, RMS, RPAS demand forecasting, SIOCS inventory, OMS order management, and retail DBA implementation and administration.',
  },
  'oracle-agile': {
    label: 'Oracle Agile',
    color: 'bg-lime-100 text-lime-800',
    description: 'Oracle Agile PLM — product lifecycle management implementation, configuration, integration with EBS and Fusion, BOM management, ECO workflows, and DBA administration.',
  },
  'oracle-siebel': {
    label: 'Oracle Siebel',
    color: 'bg-indigo-100 text-indigo-800',
    description: 'Oracle Siebel CRM — enterprise CRM implementation, Siebel Server architecture, AOM configuration, schema administration, EAI integration, workflow, and DBA operations.',
  },
  'oracle-clinical': {
    label: 'Oracle Clinical',
    color: 'bg-purple-100 text-purple-800',
    description: 'Oracle Clinical CDMS installation, sizing, DBA administration, and 21 CFR Part 11 compliance — schema management, performance tuning, patching, and clinical data operations.',
  },
  'pharma-clinical-trials': {
    label: 'Pharma Clinical Trials',
    color: 'bg-teal-100 text-teal-800',
    description: 'Clinical trial platforms, CDMS comparison, EDC architecture, and regulatory data management across Oracle Clinical, Medidata Rave, and Veeva Vault.',
  },
  'sap-hana': {
    label: 'SAP HANA',
    color: 'bg-blue-100 text-blue-800',
    description: 'SAP HANA in-memory database platform — installation on RHEL, sizing, administration, backup, and integration with life sciences workloads.',
  },
  'fusion-cloud-scm': {
    label: 'Fusion Cloud SCM',
    color: 'bg-sky-100 text-sky-800',
    description: 'Oracle Fusion Cloud SCM Inventory R13 — cloud-native inventory management, product hub, costing, transaction processing, and supply chain execution on Oracle Cloud Infrastructure.',
  },
  'obiee': {
    label: 'OBIEE',
    color: 'bg-amber-100 text-amber-800',
    description: 'Oracle Business Intelligence Enterprise Edition — RPD repository design, session variables, init blocks, security configuration, WebLogic integration, and production troubleshooting.',
  },
  'odoo': {
    label: 'Odoo ERP',
    color: 'bg-purple-100 text-purple-800',
    description: 'Odoo ERP Community and Enterprise — installation, PostgreSQL backend, module management, multi-company configuration, upgrades, and production administration on Linux.',
  },
  'otm': {
    label: 'Oracle Transportation Management',
    color: 'bg-amber-100 text-amber-800',
    description: 'Oracle Transportation Management (OTM) 6.x — installation, WebLogic domain setup, RCU schema provisioning, integration gateway, performance tuning, and production DBA administration.',
  },
  'docker-oracle': {
    label: 'Docker for Oracle',
    color: 'bg-sky-100 text-sky-800',
    description: 'Oracle Database in Docker — containerized 19c/21c deployment on RHEL, persistent volumes, cgroup resource limits, performance monitoring, and production container operations.',
  },
} as const;

export type CategoryKey = keyof typeof CATEGORIES;

// ---------------------------------------------------------------------------
// Section groupings — Life Sciences and any future top-level sections
// ---------------------------------------------------------------------------
export const CATEGORY_SECTIONS: Record<string, {
  label: string;
  color: string;
  description: string;
  categories: CategoryKey[];
}> = {
  'life-sciences': {
    label: 'Life Sciences',
    color: 'bg-emerald-100 text-emerald-800',
    description: 'Clinical data management, pharma analytics, and life sciences database platforms.',
    categories: ['oracle-clinical', 'pharma-clinical-trials', 'sap-hana'],
  },
  'oracle-fusion-cloud-scm': {
    label: 'Oracle Fusion Cloud SCM Inventory R13',
    color: 'bg-sky-100 text-sky-800',
    description: 'Oracle Fusion Cloud SCM Inventory R13 — cloud-native inventory management on OCI.',
    categories: ['fusion-cloud-scm'],
  },
  'odoo-erp': {
    label: 'Odoo ERP',
    color: 'bg-purple-100 text-purple-800',
    description: 'Odoo ERP installation, configuration, module management, and production administration — Community and Enterprise editions on Linux with PostgreSQL.',
    categories: ['odoo'],
  },
  'oracle-transportation-management': {
    label: 'Oracle Transportation Management',
    color: 'bg-amber-100 text-amber-800',
    description: 'Oracle Transportation Management (OTM) 6.x — WebLogic-based logistics and freight planning platform installation, administration, and performance operations.',
    categories: ['otm'],
  },
  'docker-for-oracle': {
    label: 'Docker for Oracle',
    color: 'bg-sky-100 text-sky-800',
    description: 'Oracle Database in Docker on RHEL — containerized 19c deployment, persistent storage, cgroup tuning, and production performance monitoring.',
    categories: ['docker-oracle'],
  },
};

// Set of category keys that belong to a named section (excluded from the main grid)
export const SECTIONED_CATEGORY_KEYS = new Set<string>(
  Object.values(CATEGORY_SECTIONS).flatMap(s => s.categories)
);

export function getCategoryLabel(key: CategoryKey): string {
  return CATEGORIES[key]?.label ?? key;
}

export function getCategoryColor(key: CategoryKey): string {
  return CATEGORIES[key]?.color ?? 'bg-gray-100 text-gray-800';
}
