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
} as const;

export type CategoryKey = keyof typeof CATEGORIES;

export function getCategoryLabel(key: CategoryKey): string {
  return CATEGORIES[key]?.label ?? key;
}

export function getCategoryColor(key: CategoryKey): string {
  return CATEGORIES[key]?.color ?? 'bg-gray-100 text-gray-800';
}
