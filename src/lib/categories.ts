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
} as const;

export type CategoryKey = keyof typeof CATEGORIES;

export function getCategoryLabel(key: CategoryKey): string {
  return CATEGORIES[key]?.label ?? key;
}

export function getCategoryColor(key: CategoryKey): string {
  return CATEGORIES[key]?.color ?? 'bg-gray-100 text-gray-800';
}
