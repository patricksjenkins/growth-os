'use client'

import { useState, useEffect } from 'react'
import { useRouter, useParams } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { ChevronLeft, ExternalLink, CheckCircle, Mail, FileText } from 'lucide-react'

/**
 * @typedef {Object} Lead
 * @property {number} id
 * @property {string} company_name
 * @property {string} domain
 * @property {string} location
 * @property {number} employee_count
 * @property {number} lead_score
 * @property {string} priority_tier
 * @property {string} status
 * @property {string} company_description
 * @property {string[]} benefits_signals
 * @property {string[]} growth_signals
 * @property {Object} score_breakdown
 * @property {string} scoring_rationale
 * @property {string} outreach_angle
 * @property {boolean} outreach_approved
 * @property {string} meeting_booked
 */

/**
 * Lead Detail Page with tabs for Overview, Contacts, Email Sequence, and Briefing
 */
export default function LeadDetailPage() {
  const router = useRouter()
  const params = useParams()
  const leadId = params?.id

  const [lead, setLead] = useState(null)
  const [contacts, setContacts] = useState([])
  const [emailSequence, setEmailSequence] = useState([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('overview')
  const [approvalToggle, setApprovalToggle] = useState(false)
  const [morganNotes, setMorganNotes] = useState('')
  const [notesLoading, setNotesLoading] = useState(false)

  useEffect(() => {
    if (leadId) {
      fetchLeadData()
    }
  }, [leadId])

  const fetchLeadData = async () => {
    setLoading(true)
    try {
      // Fetch lead
      const { data: leadData, error: leadError } = await supabase
        .from('leads_pipeline_view')
        .select('*')
        .eq('id', leadId)
        .single()

      if (leadError) throw leadError

      setLead(leadData)
      setApprovalToggle(leadData.outreach_approved)

      // Fetch contacts
      const { data: contactsData, error: contactsError } = await supabase
        .from('lead_contacts')
        .select('*')
        .eq('lead_id', leadId)
        .order('created_at', { ascending: false })

      if (contactsError) throw contactsError
      setContacts(contactsData || [])

      // Fetch email sequence
      const { data: emailData, error: emailError } = await supabase
        .from('outreach_emails')
        .select('*')
        .eq('lead_id', leadId)
        .order('sent_at', { ascending: false })

      if (emailError) throw emailError
      setEmailSequence(emailData || [])

      // Fetch Morgan's notes if meeting booked
      if (leadData.status === 'Meeting Booked') {
        const { data: briefingData, error: briefingError } = await supabase
          .from('meeting_briefings')
          .select('morgan_notes')
          .eq('lead_id', leadId)
          .single()

        if (!briefingError && briefingData?.morgan_notes) {
          setMorganNotes(briefingData.morgan_notes)
        }
      }
    } catch (error) {
      console.error('Error fetching lead data:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleApprovalToggle = async (newValue) => {
    try {
      const response = await fetch('/api/approve-lead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead_id: leadId, approved: newValue })
      })

      if (!response.ok) throw new Error('Failed to update')

      setApprovalToggle(newValue)
      fetchLeadData()
    } catch (error) {
      console.error('Error updating approval:', error)
    }
  }

  const handleStopSequence = async () => {
    if (!window.confirm('Stop the outreach sequence for this lead?')) return

    try {
      const response = await fetch('/api/stop-sequence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead_id: leadId })
      })

      if (!response.ok) throw new Error('Failed to stop sequence')

      alert('Sequence stopped successfully')
      fetchLeadData()
    } catch (error) {
      console.error('Error stopping sequence:', error)
      alert('Failed to stop sequence')
    }
  }

  const handleSaveNotes = async () => {
    setNotesLoading(true)
    try {
      const { error } = await supabase
        .from('meeting_briefings')
        .update({ morgan_notes: morganNotes })
        .eq('lead_id', leadId)

      if (error) throw error
      alert('Notes saved successfully')
    } catch (error) {
      console.error('Error saving notes:', error)
      alert('Failed to save notes')
    } finally {
      setNotesLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-teal-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading lead details...</p>
        </div>
      </div>
    )
  }

  if (!lead) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <p className="text-gray-600 text-lg">Lead not found</p>
          <Link href="/prospects" className="text-teal-600 hover:text-teal-700 mt-4 inline-block">
            Back to Pipeline
          </Link>
        </div>
      </div>
    )
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

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <div className="flex items-center gap-4 mb-6">
            <Link href="/prospects" className="text-gray-600 hover:text-gray-900">
              <ChevronLeft className="w-5 h-5" />
            </Link>
            <h1 className="text-3xl font-bold text-slate-900">{lead.company_name}</h1>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
            <div>
              <p className="text-gray-600 text-sm">Domain</p>
              <a
                href={`https://${lead.domain}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-teal-600 hover:text-teal-700 font-medium inline-flex items-center gap-2 mt-1"
              >
                {lead.domain}
                <ExternalLink className="w-4 h-4" />
              </a>
            </div>
            <div>
              <p className="text-gray-600 text-sm">Location</p>
              <p className="font-medium text-slate-900 mt-1">{lead.location}</p>
            </div>
            <div>
              <p className="text-gray-600 text-sm">Employees</p>
              <p className="font-medium text-slate-900 mt-1">{lead.employee_count}</p>
            </div>
            <div>
              <p className="text-gray-600 text-sm">Lead Score</p>
              <div className="mt-1">
                <div className="w-full bg-gray-200 rounded-full h-2">
                  <div
                    className="bg-teal-600 h-2 rounded-full"
                    style={{ width: `${Math.min(lead.lead_score, 100)}%` }}
                  ></div>
                </div>
                <p className="font-bold text-slate-900 mt-1">{lead.lead_score}/100</p>
              </div>
            </div>
          </div>

          <div className="flex gap-3 mt-6">
            <span className={`inline-block px-4 py-2 rounded-full text-sm font-medium ${getTierColor(lead.priority_tier)}`}>
              Tier {lead.priority_tier}
            </span>
            <span className={`inline-block px-4 py-2 rounded-full text-sm font-medium ${getStatusColor(lead.status)}`}>
              {lead.status}
            </span>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex gap-8">
            {['overview', 'contacts', 'email_sequence', 'briefing'].map(tab => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`py-4 px-1 border-b-2 font-medium text-sm ${
                  activeTab === tab
                    ? 'border-teal-600 text-teal-600'
                    : 'border-transparent text-gray-600 hover:text-gray-900 hover:border-gray-300'
                }`}
              >
                {tab === 'overview' && 'Overview'}
                {tab === 'contacts' && 'Contacts'}
                {tab === 'email_sequence' && 'Email Sequence'}
                {tab === 'briefing' && 'Briefing'}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Overview Tab */}
        {activeTab === 'overview' && (
          <div className="space-y-8">
            {/* Company Description */}
            <div className="bg-white rounded-lg p-6 border border-gray-200">
              <h2 className="text-lg font-bold text-slate-900 mb-4">Company Overview</h2>
              <p className="text-gray-700 leading-relaxed">{lead.company_description || 'No description available'}</p>
            </div>

            {/* Benefits Signals */}
            {lead.benefits_signals && lead.benefits_signals.length > 0 && (
              <div className="bg-white rounded-lg p-6 border border-gray-200">
                <h2 className="text-lg font-bold text-slate-900 mb-4">Benefits Signals</h2>
                <div className="flex flex-wrap gap-2">
                  {lead.benefits_signals.map((signal, idx) => (
                    <span
                      key={idx}
                      className="inline-block px-4 py-2 bg-green-100 text-green-900 rounded-full text-sm font-medium"
                    >
                      {signal}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Growth Signals */}
            {lead.growth_signals && lead.growth_signals.length > 0 && (
              <div className="bg-white rounded-lg p-6 border border-gray-200">
                <h2 className="text-lg font-bold text-slate-900 mb-4">Growth Signals</h2>
                <div className="flex flex-wrap gap-2">
                  {lead.growth_signals.map((signal, idx) => (
                    <span
                      key={idx}
                      className="inline-block px-4 py-2 bg-blue-100 text-blue-900 rounded-full text-sm font-medium"
                    >
                      {signal}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Score Breakdown */}
            {lead.score_breakdown && (
              <div className="bg-white rounded-lg p-6 border border-gray-200">
                <h2 className="text-lg font-bold text-slate-900 mb-6">Score Breakdown</h2>
                <div className="space-y-4">
                  {Object.entries(lead.score_breakdown).map(([key, value]) => (
                    <div key={key}>
                      <div className="flex justify-between mb-2">
                        <span className="font-medium text-slate-900 capitalize">
                          {key.replace(/_/g, ' ')}
                        </span>
                        <span className="font-bold text-slate-900">{value}%</span>
                      </div>
                      <div className="w-full bg-gray-200 rounded-full h-2">
                        <div
                          className="bg-teal-600 h-2 rounded-full"
                          style={{ width: `${value}%` }}
                        ></div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Scoring Rationale */}
            {lead.scoring_rationale && (
              <div className="bg-white rounded-lg p-6 border border-gray-200">
                <h2 className="text-lg font-bold text-slate-900 mb-4">Scoring Rationale</h2>
                <p className="text-gray-700 leading-relaxed">{lead.scoring_rationale}</p>
              </div>
            )}

            {/* Outreach Angle */}
            {lead.outreach_angle && (
              <div className="bg-teal-50 rounded-lg p-6 border-2 border-teal-200">
                <h2 className="text-lg font-bold text-slate-900 mb-4">Outreach Angle</h2>
                <p className="text-gray-700 leading-relaxed italic">{lead.outreach_angle}</p>
              </div>
            )}

            {/* Outreach Approval */}
            <div className="bg-white rounded-lg p-6 border border-gray-200">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-bold text-slate-900">Outreach Approved</h3>
                  <p className="text-gray-600 text-sm mt-1">
                    {approvalToggle ? 'Ready for outreach' : 'Pending approval'}
                  </p>
                </div>
                <button
                  onClick={() => handleApprovalToggle(!approvalToggle)}
                  className={`px-4 py-2 rounded font-medium ${
                    approvalToggle
                      ? 'bg-green-600 text-white hover:bg-green-700'
                      : 'bg-gray-200 text-gray-900 hover:bg-gray-300'
                  }`}
                >
                  {approvalToggle ? '✓ Approved' : 'Pending'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Contacts Tab */}
        {activeTab === 'contacts' && (
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            {contacts.length === 0 ? (
              <div className="p-12 text-center">
                <p className="text-gray-500">No contacts found</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase">Name</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase">Title</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase">Persona</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase">Email</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase">LinkedIn</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {contacts.map(contact => (
                      <tr key={contact.id} className="hover:bg-gray-50">
                        <td className="px-6 py-4 font-medium text-slate-900">{contact.name}</td>
                        <td className="px-6 py-4 text-gray-600">{contact.title}</td>
                        <td className="px-6 py-4">
                          <span className="inline-block px-3 py-1 bg-blue-100 text-blue-900 rounded-full text-sm font-medium">
                            {contact.persona}
                          </span>
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-2">
                            <a href={`mailto:${contact.email}`} className="text-teal-600 hover:text-teal-700">
                              {contact.email}
                            </a>
                            {contact.email_verified && (
                              <CheckCircle className="w-4 h-4 text-green-600" />
                            )}
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          {contact.linkedin_url && (
                            <a
                              href={contact.linkedin_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-600 hover:text-blue-700 inline-flex items-center gap-2"
                            >
                              Profile
                              <ExternalLink className="w-4 h-4" />
                            </a>
                          )}
                        </td>
                        <td className="px-6 py-4">
                          <span className="text-sm text-gray-600">{contact.outreach_status || '-'}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Email Sequence Tab */}
        {activeTab === 'email_sequence' && (
          <div className="space-y-6">
            {emailSequence.length === 0 ? (
              <div className="bg-white rounded-lg p-12 border border-gray-200 text-center">
                <Mail className="w-12 h-12 text-gray-400 mx-auto mb-4" />
                <p className="text-gray-500">No emails sent yet</p>
              </div>
            ) : (
              <>
                <div className="space-y-4">
                  {emailSequence.map(email => (
                    <div key={email.id} className="bg-white rounded-lg p-6 border border-gray-200">
                      <div className="flex justify-between items-start mb-4">
                        <div>
                          <h3 className="font-bold text-slate-900">{email.subject}</h3>
                          <p className="text-gray-600 text-sm mt-1">
                            Sent: {new Date(email.sent_at).toLocaleDateString()}
                          </p>
                        </div>
                        <span className={`inline-block px-3 py-1 rounded-full text-sm font-medium ${
                          email.status === 'opened' ? 'bg-green-100 text-green-900' :
                          email.status === 'clicked' ? 'bg-blue-100 text-blue-900' :
                          email.status === 'replied' ? 'bg-purple-100 text-purple-900' :
                          'bg-gray-100 text-gray-900'
                        }`}>
                          {email.status}
                        </span>
                      </div>

                      {email.tracking_events && email.tracking_events.length > 0 && (
                        <div className="mb-4 p-3 bg-gray-50 rounded text-sm">
                          <p className="text-gray-700">
                            <strong>Engagement:</strong> {email.tracking_events.join(', ')}
                          </p>
                        </div>
                      )}

                      {email.reply_text && (
                        <div className="border-t border-gray-200 pt-4 mt-4">
                          <p className="text-gray-600 text-sm font-medium mb-2">Reply Received</p>
                          <p className="text-gray-700 italic mb-3">{email.reply_text}</p>
                          {email.reply_classification && (
                            <span className="inline-block px-3 py-1 bg-orange-100 text-orange-900 rounded text-sm font-medium">
                              {email.reply_classification}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                <button
                  onClick={handleStopSequence}
                  className="w-full px-4 py-3 bg-red-600 text-white rounded-lg font-medium hover:bg-red-700"
                >
                  Stop Outreach Sequence
                </button>
              </>
            )}
          </div>
        )}

        {/* Briefing Tab */}
        {activeTab === 'briefing' && (
          <>
            {lead.status !== 'Meeting Booked' ? (
              <div className="bg-white rounded-lg p-12 border border-gray-200 text-center">
                <FileText className="w-12 h-12 text-gray-400 mx-auto mb-4" />
                <p className="text-gray-500">Briefing only available for meetings booked</p>
              </div>
            ) : (
              <div className="space-y-6">
                {/* Meeting Details */}
                <div className="bg-white rounded-lg p-6 border border-gray-200">
                  <h2 className="text-lg font-bold text-slate-900 mb-4">Meeting Details</h2>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <p className="text-gray-600 text-sm">Date & Time</p>
                      <p className="font-medium text-slate-900 mt-1">
                        {lead.meeting_booked ? new Date(lead.meeting_booked).toLocaleString() : 'TBD'}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Briefing Sections */}
                <div className="space-y-4">
                  {[
                    { key: 'executive_summary', title: 'Executive Summary' },
                    { key: 'company_background', title: 'Company Background' },
                    { key: 'key_challenges', title: 'Key Challenges' },
                    { key: 'wellmor_solution', title: 'How WellMor Helps' },
                    { key: 'success_metrics', title: 'Success Metrics' },
                    { key: 'next_steps', title: 'Next Steps' },
                    { key: 'objection_handling', title: 'Potential Objections' },
                    { key: 'closing_strategy', title: 'Closing Strategy' }
                  ].map(section => (
                    <div key={section.key} className="bg-white rounded-lg p-6 border border-gray-200">
                      <h3 className="font-bold text-slate-900 mb-3">{section.title}</h3>
                      <p className="text-gray-700 leading-relaxed">
                        {lead[section.key] || 'No content available'}
                      </p>
                    </div>
                  ))}
                </div>

                {/* Morgan's Notes */}
                <div className="bg-white rounded-lg p-6 border border-gray-200">
                  <h2 className="text-lg font-bold text-slate-900 mb-4">Morgan's Notes</h2>
                  <textarea
                    value={morganNotes}
                    onChange={(e) => setMorganNotes(e.target.value)}
                    className="w-full p-4 border border-gray-300 rounded-lg focus:ring-2 focus:ring-teal-500 focus:border-transparent"
                    rows="8"
                    placeholder="Add notes about the meeting here..."
                  ></textarea>
                  <button
                    onClick={handleSaveNotes}
                    disabled={notesLoading}
                    className="mt-4 px-4 py-2 bg-teal-600 text-white rounded-lg font-medium hover:bg-teal-700 disabled:opacity-50"
                  >
                    {notesLoading ? 'Saving...' : 'Save Notes'}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
