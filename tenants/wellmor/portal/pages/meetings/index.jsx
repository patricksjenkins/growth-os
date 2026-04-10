'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { ChevronLeft, Calendar, Users, TrendingUp } from 'lucide-react'

/**
 * @typedef {Object} Meeting
 * @property {number} id
 * @property {string} contact_name
 * @property {string} contact_title
 * @property {string} company_name
 * @property {number} employee_count
 * @property {string} meeting_type
 * @property {string} scheduled_at
 * @property {number} lead_id
 */

/**
 * Meetings Dashboard for Morgan to manage meetings and outcomes
 */
export default function MeetingsPage() {
  const [upcomingMeetings, setUpcomingMeetings] = useState([])
  const [pastMeetings, setPastMeetings] = useState([])
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(true)
  const [editingMeetingId, setEditingMeetingId] = useState(null)
  const [editingNotes, setEditingNotes] = useState('')
  const [editingOutcome, setEditingOutcome] = useState('')

  useEffect(() => {
    fetchData()
  }, [])

  const fetchData = async () => {
    setLoading(true)
    try {
      const now = new Date()

      // Fetch upcoming meetings
      const { data: upcomingData, error: upcomingError } = await supabase
        .from('scheduled_meetings')
        .select(`
          *,
          lead_id,
          contact:lead_contacts(name, title),
          lead:leads_pipeline_view(company_name, employee_count)
        `)
        .gt('scheduled_at', now.toISOString())
        .order('scheduled_at', { ascending: true })

      if (upcomingError) throw upcomingError
      setUpcomingMeetings(upcomingData || [])

      // Fetch past meetings
      const { data: pastData, error: pastError } = await supabase
        .from('scheduled_meetings')
        .select(`
          *,
          lead_id,
          contact:lead_contacts(name, title),
          lead:leads_pipeline_view(company_name, employee_count)
        `)
        .lt('scheduled_at', now.toISOString())
        .order('scheduled_at', { ascending: false })
        .limit(50)

      if (pastError) throw pastError
      setPastMeetings(pastData || [])

      // Calculate stats
      const thisMonth = new Date()
      thisMonth.setDate(1)

      const thisQuarter = new Date()
      thisQuarter.setMonth(Math.floor(thisQuarter.getMonth() / 3) * 3)
      thisQuarter.setDate(1)

      const { data: monthData } = await supabase
        .from('scheduled_meetings')
        .select('*')
        .gte('scheduled_at', thisMonth.toISOString())
        .lte('scheduled_at', new Date().toISOString())

      const { data: wonData } = await supabase
        .from('scheduled_meetings')
        .select('*')
        .eq('outcome', 'closed_won')
        .gte('scheduled_at', thisQuarter.toISOString())

      const { data: proposalData } = await supabase
        .from('scheduled_meetings')
        .select('*')
        .eq('outcome', 'proposal_sent')

      const meetingsThisMonth = monthData?.length || 0
      const closedWon = wonData?.length || 0
      const proposalSent = proposalData?.length || 0
      const conversionRate = proposalSent > 0 ? Math.round((closedWon / proposalSent) * 100) : 0

      setStats({
        meetingsThisMonth,
        conversionRateToProposal: conversionRate,
        wonDealsThisQuarter: closedWon
      })
    } catch (error) {
      console.error('Error fetching meetings:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleSaveOutcome = async (meetingId) => {
    try {
      const { error } = await supabase
        .from('scheduled_meetings')
        .update({
          outcome: editingOutcome,
          morgan_notes: editingNotes
        })
        .eq('id', meetingId)

      if (error) throw error

      setEditingMeetingId(null)
      setEditingNotes('')
      setEditingOutcome('')
      alert('Meeting outcome saved!')
      fetchData()
    } catch (error) {
      console.error('Error saving outcome:', error)
      alert('Failed to save outcome')
    }
  }

  const startEdit = (meeting) => {
    setEditingMeetingId(meeting.id)
    setEditingOutcome(meeting.outcome || '')
    setEditingNotes(meeting.morgan_notes || '')
  }

  const cancelEdit = () => {
    setEditingMeetingId(null)
    setEditingNotes('')
    setEditingOutcome('')
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-teal-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading meetings...</p>
        </div>
      </div>
    )
  }

  const getOutcomeColor = (outcome) => {
    const colors = {
      'proposal_sent': 'bg-blue-100 text-blue-900',
      'not_a_fit': 'bg-red-100 text-red-900',
      'follow_up_needed': 'bg-yellow-100 text-yellow-900',
      'closed_won': 'bg-green-100 text-green-900'
    }
    return colors[outcome] || 'bg-gray-100 text-gray-900'
  }

  const getOutcomeLabel = (outcome) => {
    const labels = {
      'proposal_sent': 'Proposal Sent',
      'not_a_fit': 'Not a Fit',
      'follow_up_needed': 'Follow-up Needed',
      'closed_won': 'Closed Won'
    }
    return labels[outcome] || 'Pending'
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <div className="flex items-center gap-4 mb-6">
            <Link href="/dashboard" className="text-gray-600 hover:text-gray-900">
              <ChevronLeft className="w-5 h-5" />
            </Link>
            <h1 className="text-3xl font-bold text-slate-900">Meetings</h1>
          </div>

          {/* Stats */}
          {stats && (
            <div className="grid grid-cols-3 gap-4">
              <div className="bg-gradient-to-br from-blue-50 to-blue-100 rounded-lg p-6 border border-blue-200">
                <div className="flex items-center gap-4">
                  <Calendar className="w-8 h-8 text-blue-600" />
                  <div>
                    <p className="text-gray-600 text-sm">Meetings This Month</p>
                    <p className="text-3xl font-bold text-slate-900">{stats.meetingsThisMonth}</p>
                  </div>
                </div>
              </div>
              <div className="bg-gradient-to-br from-purple-50 to-purple-100 rounded-lg p-6 border border-purple-200">
                <div className="flex items-center gap-4">
                  <TrendingUp className="w-8 h-8 text-purple-600" />
                  <div>
                    <p className="text-gray-600 text-sm">Conversion to Proposal</p>
                    <p className="text-3xl font-bold text-slate-900">{stats.conversionRateToProposal}%</p>
                  </div>
                </div>
              </div>
              <div className="bg-gradient-to-br from-green-50 to-green-100 rounded-lg p-6 border border-green-200">
                <div className="flex items-center gap-4">
                  <Users className="w-8 h-8 text-green-600" />
                  <div>
                    <p className="text-gray-600 text-sm">Won Deals This Quarter</p>
                    <p className="text-3xl font-bold text-slate-900">{stats.wonDealsThisQuarter}</p>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Upcoming Meetings Section */}
        <div className="mb-12">
          <h2 className="text-2xl font-bold text-slate-900 mb-6">Upcoming Meetings</h2>

          {upcomingMeetings.length === 0 ? (
            <div className="bg-white rounded-lg p-12 border border-gray-200 text-center">
              <Calendar className="w-12 h-12 text-gray-400 mx-auto mb-4" />
              <p className="text-gray-500 text-lg">No upcoming meetings scheduled</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {upcomingMeetings.map(meeting => (
                <div key={meeting.id} className="bg-white rounded-lg p-6 border-2 border-teal-200">
                  <div className="mb-4">
                    <p className="text-gray-600 text-sm font-medium">
                      {new Date(meeting.scheduled_at).toLocaleDateString()} at {new Date(meeting.scheduled_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </p>
                    <h3 className="text-lg font-bold text-slate-900 mt-2">
                      {meeting.contact?.name || 'Unknown Contact'}
                    </h3>
                    <p className="text-gray-600 text-sm">{meeting.contact?.title}</p>
                  </div>

                  <div className="border-t border-gray-200 pt-4 my-4">
                    <p className="font-medium text-slate-900">{meeting.lead?.company_name}</p>
                    <p className="text-gray-600 text-sm mt-1">
                      {meeting.lead?.employee_count} employees
                    </p>
                  </div>

                  <div className="flex items-center justify-between">
                    {meeting.meeting_type && (
                      <span className="inline-block px-3 py-1 bg-blue-100 text-blue-900 rounded-full text-sm font-medium">
                        {meeting.meeting_type}
                      </span>
                    )}
                    <Link
                      href={`/prospects/${meeting.lead_id}`}
                      className="text-teal-600 hover:text-teal-700 font-medium text-sm"
                    >
                      View Briefing
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Past Meetings Section */}
        <div>
          <h2 className="text-2xl font-bold text-slate-900 mb-6">Past Meetings</h2>

          {pastMeetings.length === 0 ? (
            <div className="bg-white rounded-lg p-12 border border-gray-200 text-center">
              <p className="text-gray-500 text-lg">No past meetings</p>
            </div>
          ) : (
            <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase">
                        Date & Time
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase">
                        Contact
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase">
                        Company
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase">
                        Outcome
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {pastMeetings.map(meeting => (
                      <tr key={meeting.id} className="hover:bg-gray-50">
                        <td className="px-6 py-4 text-sm">
                          <p className="font-medium text-slate-900">
                            {new Date(meeting.scheduled_at).toLocaleDateString()}
                          </p>
                          <p className="text-gray-600">
                            {new Date(meeting.scheduled_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </p>
                        </td>
                        <td className="px-6 py-4">
                          <p className="font-medium text-slate-900">{meeting.contact?.name}</p>
                          <p className="text-gray-600 text-sm">{meeting.contact?.title}</p>
                        </td>
                        <td className="px-6 py-4 font-medium text-slate-900">
                          {meeting.lead?.company_name}
                        </td>
                        <td className="px-6 py-4">
                          {editingMeetingId === meeting.id ? (
                            <select
                              value={editingOutcome}
                              onChange={(e) => setEditingOutcome(e.target.value)}
                              className="px-3 py-1 border border-gray-300 rounded text-sm focus:ring-2 focus:ring-teal-500"
                            >
                              <option value="">Select outcome...</option>
                              <option value="proposal_sent">Proposal Sent</option>
                              <option value="not_a_fit">Not a Fit</option>
                              <option value="follow_up_needed">Follow-up Needed</option>
                              <option value="closed_won">Closed Won</option>
                            </select>
                          ) : (
                            <span className={`inline-block px-3 py-1 rounded-full text-sm font-medium ${getOutcomeColor(meeting.outcome)}`}>
                              {getOutcomeLabel(meeting.outcome) || 'Pending'}
                            </span>
                          )}
                        </td>
                        <td className="px-6 py-4">
                          {editingMeetingId === meeting.id ? (
                            <div className="flex gap-2">
                              <button
                                onClick={() => handleSaveOutcome(meeting.id)}
                                className="px-3 py-1 bg-green-600 text-white rounded text-sm font-medium hover:bg-green-700"
                              >
                                Save
                              </button>
                              <button
                                onClick={cancelEdit}
                                className="px-3 py-1 bg-gray-300 text-gray-900 rounded text-sm font-medium hover:bg-gray-400"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => startEdit(meeting)}
                              className="text-teal-600 hover:text-teal-700 font-medium text-sm"
                            >
                              Log Outcome
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {/* Edit Notes Modal */}
        {editingMeetingId && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 mt-8">
            <div className="bg-white rounded-lg p-8 max-w-2xl w-full mx-4 max-h-96 overflow-y-auto">
              <h2 className="text-2xl font-bold text-slate-900 mb-6">Log Meeting Outcome</h2>

              <div className="mb-6">
                <label className="block text-sm font-medium text-gray-700 mb-2">Outcome</label>
                <select
                  value={editingOutcome}
                  onChange={(e) => setEditingOutcome(e.target.value)}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-teal-500"
                >
                  <option value="">Select outcome...</option>
                  <option value="proposal_sent">Proposal Sent</option>
                  <option value="not_a_fit">Not a Fit</option>
                  <option value="follow_up_needed">Follow-up Needed</option>
                  <option value="closed_won">Closed Won</option>
                </select>
              </div>

              <div className="mb-6">
                <label className="block text-sm font-medium text-gray-700 mb-2">Notes</label>
                <textarea
                  value={editingNotes}
                  onChange={(e) => setEditingNotes(e.target.value)}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-teal-500"
                  rows="6"
                  placeholder="Add any notes about the meeting..."
                ></textarea>
              </div>

              <div className="flex gap-3">
                <button
                  onClick={() => {
                    const meetingId = editingMeetingId
                    handleSaveOutcome(meetingId)
                  }}
                  className="flex-1 px-4 py-2 bg-teal-600 text-white rounded-lg font-medium hover:bg-teal-700"
                >
                  Save Outcome
                </button>
                <button
                  onClick={cancelEdit}
                  className="flex-1 px-4 py-2 border border-gray-300 rounded-lg font-medium hover:bg-gray-50"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
