import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as api from '../api/finance';

export function useIncome(month: number, year: number) {
  return useQuery({
    queryKey: ['income', month, year],
    queryFn: () => api.getIncome(month, year),
  });
}

export function useAddIncome() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Parameters<typeof api.addIncome>[0]) => api.addIncome(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['income'] }),
  });
}

export function useUpdateIncome() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<api.IncomeEntry> }) => api.updateIncome(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['income'] }),
  });
}

export function useDeleteIncome() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteIncome(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['income'] }),
  });
}

export function useExpenses(month: number, year: number) {
  return useQuery({
    queryKey: ['expenses', month, year],
    queryFn: () => api.getExpenses(month, year),
  });
}

export function useAddExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Parameters<typeof api.addExpense>[0]) => api.addExpense(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['expenses'] }),
  });
}

export function useUpdateExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<api.ExpenseEntry> }) => api.updateExpense(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['expenses'] }),
  });
}

export function useDeleteExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteExpense(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['expenses'] }),
  });
}

export function useRolloverExpenses() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ month, year }: { month: number; year: number }) => api.rolloverExpenses(month, year),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['expenses'] }),
  });
}

export function useCustomers() {
  return useQuery({
    queryKey: ['customers'],
    queryFn: () => api.getCustomers(),
  });
}

export function useCustomerInsights(year?: number) {
  return useQuery({
    queryKey: ['customer-insights', year],
    queryFn: () => api.getCustomerInsights(year),
  });
}

export function useDashboard(year: number) {
  return useQuery({
    queryKey: ['dashboard', year],
    queryFn: () => api.getDashboard(year),
  });
}

export function useYearlySummary(year: number) {
  return useQuery({
    queryKey: ['yearly-summary', year],
    queryFn: () => api.getYearlySummary(year),
  });
}

export function useCrewMembers() {
  return useQuery({
    queryKey: ['crew'],
    queryFn: () => api.getCrewMembers(),
  });
}

export function useAddCrewMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; daily_rate: number }) => api.addCrewMember(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crew'] }),
  });
}

export function useUpdateCrewMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<api.CrewMember> }) => api.updateCrewMember(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crew'] }),
  });
}

export function useDeleteCrewMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteCrewMember(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crew'] }),
  });
}

export function useCrewLogs(month: number, year: number) {
  return useQuery({
    queryKey: ['crew-logs', month, year],
    queryFn: () => api.getCrewLogs(month, year),
  });
}

export function useToggleCrewLog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ crew_member_id, date }: { crew_member_id: string; date: string }) =>
      api.toggleCrewLog(crew_member_id, date),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crew-logs'] }),
  });
}

export function useCrewYearlySummary(year: number) {
  return useQuery({
    queryKey: ['crew-yearly', year],
    queryFn: () => api.getCrewYearlySummary(year),
  });
}

export function useDebts() {
  return useQuery({
    queryKey: ['debts'],
    queryFn: () => api.getDebts(),
  });
}

export function useAddDebt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Parameters<typeof api.addDebt>[0]) => api.addDebt(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['debts'] }),
  });
}

export function useUpdateDebt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<api.DebtEntry> }) => api.updateDebt(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['debts'] }),
  });
}

export function useDeleteDebt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteDebt(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['debts'] }),
  });
}

export function usePLReport(year: number) {
  return useQuery({
    queryKey: ['pl-report', year],
    queryFn: () => api.getPLReport(year),
  });
}

export function useJobs(page = 1) {
  return useQuery({
    queryKey: ['jobs', page],
    queryFn: () => api.getJobs(page),
  });
}

export function useLeads(status = '', page = 1) {
  return useQuery({
    queryKey: ['leads', status, page],
    queryFn: () => api.getLeads(status, page),
  });
}

export function useUpdateLead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) => api.updateLead(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['leads'] }),
  });
}
