export type LogFilterType = 'all' | 'fortinet' | 'atrust';

export interface FilterOption {
  label: string;
  value: LogFilterType;
}

export const FILTER_OPTIONS: FilterOption[] = [
  { label: '全部日志', value: 'all' },
  { label: 'Fortinet VPN', value: 'fortinet' },
  { label: 'aTrust VPN', value: 'atrust' },
];
