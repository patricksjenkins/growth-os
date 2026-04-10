'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { ChevronLeft, Download, Eye } from 'lucide-react'

/**
 * @typedef {Object} Lead
 * @property {number} id
 * @property {string} company_name
 * @property {string} industry
 * @property {number} employee_count
 * @property {number} lead_score
 * @property {string} priority_tier
 * @property {string} status
 * @property {string} location
 * @property {boolean} outreach_approved
 * @property {string} domain
 */

/**
 * Prospects Pipeline Dashboard
 * Shows all leads with filtering, approval queue, and bulk actions
 */
export default function ProspectsPage() {
  const [leads, setLeads] = useState([])
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  const [filterTier, setFilterTier] = useState('All')
  const [filterStatus, setFilterStatus] = useState('All')
  const [currentPage, setCurrentPage] = useState(1)
  const [approvalQueue, setApprovalQueue] = useState([])

  const ITEMS_PER_PAGE = 25

  useEffect(() => {
    fetchData()
  }, [])

  const fetchData = async () => {
    setLoading(true)
    try {
      // Fetch stats
      const { data: statsData, error: statsError } = await supabase
        .from('leads_pipeline_view')
        .select('*', { count: 'exact' })

      if (statsError) throw statsError

      const totalProspects = statsData?.length || 0
      const tierACount = statsData?.filter(l => l.priority_tier === 'A').length || 0
      const inSequenceCount = statsData?.filter(l => l.status === 'In Sequence').length || 0
      const meetingsBookedCount = statsData?.filter(l => l.status === 'Meeting Booked').length || 0

      setStats({
        totalProspects,
        tierACount,
        inSequenceCount,
        meetingsBookedCount
      })

      // Fetch leads
      const { data: leadsData, error: leadsError } = await supabase
        .from('leads_pipeline_view')
        .select('*')
        .order('lead_score', { ascending: false })

      if (leadsError) throw leadsError

      setLeads(leadsData || [])

      // Fetch approval queue (Tier B, not approved)
      const approvalQueueData = (leadsData || []).filter(
        l => l.priority_tier === 'B' && !l.outreach_approved
      )
      setApprovalQueue(approvalQueueData)
    } catch (error) {
      console.error('Error fetching data:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleApprove = async (leadId) => {
    try {
      const response = await fetch('/api/approve-lead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead_id: leadId, approved: true })
      })

      if (!response.ok) throw new Error('Failed to approve')

      await fetchData()
    } catch (error) {
      console.error('Error approving lead:', error)
    }
  }

  const handleReject = async (leadId) => {
    try {
      const response = await fetch('/api/approve-lead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead_id: leadId, approved: false })
      })

      if (!response.ok) throw new Error('Failed to reject')

      await fetchData()
    } catch (error) {
      console.error('Error rejecting lead:', error)
    }
  }

  const handleToggleApproval = async (leadId, currentStatus) => {
    try {
      const response = await fetch('/api/approve-lead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead_id: leadId, approved: !currentStatus })
      })

      if (!response.ok) throw new Error('Failed to update approval')

      await fetchData()
    } catch (error) {
      console.error('Error updating approval:', error)
    }
  }

  const filteredLeads = leads.filter(lead => {
    const matchesTier = filterTier === 'All' || lead.priority_tier === filterTier
    const matchesStatus = filterStatus === 'All' || lead.status === filterStatus
    const matchesSearch = lead.company_name
      .toLowerCase()
      .includes(searchTerm.toLowerCase())

    return matchesTier && matchesStatus && matchesSearch
  })

  const paginatedLeads = filteredLeads.slice(
    (currentPage - 1) * ITEMS_PER_PAGE,
    currentPage * ITEMS_PER_PAGE
  )

  const totalPages = Math.ceil(filteredLeads.length / ITEMS_PER_PAGE)

  const exportCSV = () => {
    const headers = ['Company', 'Industry', 'Employees', 'Score', 'Tier', 'Status', 'Location']
    const rows = filteredLeads.map(lead => [
      lead.company_name,
      lead.industry,
      lead.employee_count,
      lead.lead_score,
      lead.priority_tier,
      lead.status,
      lead.location
    ])

    const csv = [headers, ...rows].map(row => row.map(cell => `"${cell}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = window.URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `prospects-${new Date().toISOString().split('T')[0]}.csv`
    a.click()
  }

  const getScoreColor = (score) => {
    if (score >= 75) return 'bg-green-100 text-green-900'
    if (score >= 50) return 'bg-yellow-100 text-yellow-900'
    return 'bg-gray-100 text-gray-900'
  }

  const getTierColor = (tier) => {
    if (tier === 'A') return 'bg-green-100 text-green-900'
    if (tier === 'B') return 'bg-yellow-100 text-yellow-900'
    return 'bg-gray-100 text-gray-900'
  }

  const getStatusColor = (status) => {
    const colors = {
      'New': 'bg-blue-100 text-blue-900',
      'Scored': 'bg-purple-100 text-purple-900',
      'In Sequence': 'bg-orange-100 text-orange-900',
      'Interested': 'bg-teal-100 text-teal-900',
      'Meeting Booked': 'bg-green-100 text-green-900'
    }
    return colors[status] || 'bg-gray-100 text-gray-900'
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-teal-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading prospects...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Link href="/dashboard" className="text-gray-600 hover:text-gray-900">
                <ChevronLeft className="w-5 h-5" />
              </Link>
              <h1 className="text-3xl font-bold text-slate-900">Prospect Pipeline</h1>
            </div>
            <button
              onClick={exportCSV}
              className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 font-medium text-gray-700"
            >
              <Download className="w-4 h-4" />
              Export CSV
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Stats Bar */}
        {stats && (
          <div className="grid grid-cols-4 gap-4 mb-8">
            <div className="bg-white rounded-lg p-6 border border-gray-200">
              <div className="text-gray-600 text-sm font-medium">Total Prospects</div>
              <div className="text-3xl font-bold text-slate-900 mt-2">{stats.totalProspects}</div>
            </div>
            <div className="bg-white rounded-lg p-6 border border-gray-200">
              <div className="text-gray-600 text-sm font-medium">Tier A Leads</div>
              <div className="text-3xl font-bold text-green-600 mt-2">{stats.tierACount}</div>
            </div>
            <div className="bg-white rounded-lg p-6 border border-gray-200">
              <div className="text-gray-600 text-sm font-medium">In Sequence</div>
              <div className="text-3xl font-bold text-orange-600 mt-2">{stats.inSequenceCount}</div>
            </div>
            <div className="bg-white rounded-lg p-6 border border-gray-200">
              <div className="text-gray-600 text-sm font-medium">Meetings Booked</div>
              <div className="text-3xl font-bold text-teal-600 mt-2">{stats.meetingsBookedCount}</div>
            </div>
          </div>
        )}

        {/* Approval Queue */}
        {approvalQueue.length > 0 && (
          <div className="mb-8">
            <h2 className="text-xl font-bold text-slate-900 mb-4">Approval Queue ({approvalQueue.length})</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {approvalQueue.map(lead => (
                <div key={lead.id} className="bg-white rounded-lg p-6 border-2 border-yellow-300">
                  <h3 className="font-bold text-slate-900">{lead.company_name}</h3>
                  <p className="text-gray-600 text-sm mt-2">{lead.industry}</p>
                  <p className="text-gray-600 text-sm">{lead.employee_count} employees</p>
                  <div className="mt-4 flex gap-3">
                    <button
                      onClick={() => handleApprove(lead.id)}
                      className="flex-1 px-3 py-2 bg-green-600 text-white rounded font-medium hover:bg-green-700"
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => handleReject(lead.id)}
                      className="flex-1 px-3 py-2 bg-red-600 text-white rounded font-medium hover:bg-red-700"
                    >
                      Reject
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Filters */}
        <div className="bg-white rounded-lg p-6 border border-gray-200 mb-6">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Search Company</label>
              <input
                type="text"
                placeholder="Company name..."
                value={searchTerm}
                onChange={(e) => {
                  setSearchTerm(e.target.value)
                  setCurrentPage(1)
                }}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-teal-500 focus:border-transparent"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Tier</label>
              <select
                value={filterTier}
                onChange={(e) => {
                  setFilterTier(e.target.value)
                  setCurrentPage(1)
                }}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-teal-500 focus:border-transparent"
              >
                <option value="All">All Tiers</option>
                <option value="A">Tier A</option>
                <option value="B">Tier B</option>
                <option value="C">Tier C</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Status</label>
              <select
                value={filterStatus}
                onChange={(e) => {
                  setFilterStatus(e.target.value)
                  setCurrentPage(1)
                }}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-teal-500 focus:border-transparent"
              >
                <option value="All">All Status</option>
                <option value="New">New</option>
                <option value="Scored">Scored</option>
                <option value="In Sequence">In Sequence</option>
                <option value="Interested">Interested</option>
                <option value="Meeting Booked">Meeting Booked</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Results</label>
              <div className="text-2xl font-bold text-slate-900">{filteredLeads.length}</div>
            </div>
          </div>
        </div>

        {/* Leads Table */}
        {paginatedLeads.length === 0 ? (
          <div className="bg-white rounded-lg p-12 border border-gray-200 text-center">
            <p className="text-gray-500 text-lg">No prospects found</p>
          </div>
        ) : (
          <>
            <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                        Company
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                        Industry
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                        Employees
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                        Score
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                        Tier
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                        Status
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                        Location
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                        Approved
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {paginatedLeads.map(lead => (
                      <tr key={lead.id} className="hover:bg-gray-50">
                        <td className="px-6 py-4 whitespace-nowrap font-medium text-slate-900">
                          {lead.company_name}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-gray-600">
                          {lead.industry}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-gray-600">
                          {lead.employee_count}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <span className={`inline-block px-3 py-1 rounded-full text-sm font-medium ${getScoreColor(lead.lead_score)}`}>
                            {lead.lead_score}
                          </span>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <span className={`inline-block px-3 py-1 rounded-full text-sm font-medium ${getTierColor(lead.priority_tier)}`}>
                            {lead.priority_tier}
                          </span>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <span className={`inline-block px-3 py-1 rounded-full text-sm font-medium ${getStatusColor(lead.status)}`}>
                            {lead.status}
                          </span>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-gray-600">
                          {lead.location}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <button
                            onClick={() => handleToggleApproval(lead.id, lead.outreach_approved)}
                            className={`px-3 py-1 rounded text-sm font-medium ${
                              lead.outreach_approved
                                ? 'bg-green-100 text-green-900'
                                : 'bg-gray-100 text-gray-900 hover:bg-gray-200'
                            }`}
                          >
                            {lead.outreach_approved ? '✓ Approved' : 'Pending'}
                          </button>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <Link
                            href={`/prospects/${lead.id}`}
                            className="inline-flex items-center gap-2 text-teal-600 hover:text-teal-700 font-medium"
                          >
                            <Eye className="w-4 h-4" />
                            Details
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="mt-6 flex items-center justify-center gap-2">
                <button
                  onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                  className="px-3 py-2 border border-gray-300 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50"
                >
                  Previous
                </button>
                <div className="flex gap-1">
                  {Array.from({ length: totalPages }, (_, i) => i + 1).map(page => (
                    <button
                      key={page}
                      onClick={() => setCurrentPage(page)}
                      className={`px-3 py-2 rounded-lg ${
                        currentPage === page
                          ? 'bg-teal-600 text-white'
                          : 'border border-gray-300 hover:bg-gray-50'
                      }`}
                    >
                      {page}
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                  className="px-3 py-2 border border-gray-300 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50"
                >
                  Next
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
