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
} as const;

export type CategoryKey = keyof typeof CATEGORIES;

export function getCategoryLabel(key: CategoryKey): string {
  return CATEGORIES[key]?.label ?? key;
}

export function getCategoryColor(key: CategoryKey): string {
  return CATEGORIES[key]?.color ?? 'bg-gray-100 text-gray-800';
}
