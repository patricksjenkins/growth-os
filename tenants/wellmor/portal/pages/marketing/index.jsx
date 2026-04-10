'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { ChevronLeft, Calendar, Edit2, Check, X } from 'lucide-react'

/**
 * @typedef {Object} Stats
 * @property {number} totalLeadsGenerated
 * @property {number} costPerLead
 * @property {number} activeSequences
 * @property {number} postsPublished
 * @property {number} engagementRate
 */

/**
 * Marketing Dashboard for social posts, email performance, and lead generation
 */
export default function MarketingPage() {
  const [stats, setStats] = useState(null)
  const [upcomingPosts, setUpcomingPosts] = useState([])
  const [socialPosts, setSocialPosts] = useState([])
  const [emailPerformance, setEmailPerformance] = useState([])
  const [loading, setLoading] = useState(true)
  const [dateRange, setDateRange] = useState('30')
  const [editingPostId, setEditingPostId] = useState(null)
  const [editingPostText, setEditingPostText] = useState('')
  const [modalOpen, setModalOpen] = useState(false)

  useEffect(() => {
    fetchData()
  }, [dateRange])

  const fetchData = async () => {
    setLoading(true)
    try {
      const daysAgo = new Date()
      daysAgo.setDate(daysAgo.getDate() - parseInt(dateRange))

      // Fetch stats
      const { data: leadsData } = await supabase
        .from('leads_pipeline_view')
        .select('*')
        .gte('created_at', daysAgo.toISOString())

      const { data: sequencesData } = await supabase
        .from('outreach_campaigns')
        .select('*')
        .eq('status', 'active')

      const { data: socialPostsData } = await supabase
        .from('social_posts')
        .select('*')
        .eq('status', 'published')
        .gte('created_at', daysAgo.toISOString())

      const totalLeads = leadsData?.length || 0
      const costPerLead = totalLeads > 0 ? Math.round(5000 / totalLeads) : 0
      const activeSequences = sequencesData?.length || 0
      const postsPublished = socialPostsData?.length || 0
      const engagementRate = Math.round(Math.random() * 100 * 10) / 10 // Replace with real data

      setStats({
        totalLeadsGenerated: totalLeads,
        costPerLead,
        activeSequences,
        postsPublished,
        engagementRate
      })

      // Fetch upcoming posts
      const upcomingDate = new Date()
      upcomingDate.setDate(upcomingDate.getDate() + 7)

      const { data: upcomingPostsData } = await supabase
        .from('social_posts')
        .select('*')
        .in('status', ['scheduled', 'needs_review'])
        .lte('scheduled_date', upcomingDate.toISOString())
        .gte('scheduled_date', new Date().toISOString())
        .order('scheduled_date', { ascending: true })

      setUpcomingPosts(upcomingPostsData || [])

      // Fetch published posts
      const { data: publishedPostsData } = await supabase
        .from('social_posts')
        .select('*')
        .eq('status', 'published')
        .order('published_at', { ascending: false })
        .limit(10)

      setSocialPosts(publishedPostsData || [])

      // Fetch email performance
      const { data: emailSeqData } = await supabase
        .from('email_sequence_performance')
        .select('*')

      setEmailPerformance(emailSeqData || [])
    } catch (error) {
      console.error('Error fetching data:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleApprovePost = async (postId) => {
    try {
      const { error } = await supabase
        .from('social_posts')
        .update({ status: 'scheduled' })
        .eq('id', postId)

      if (error) throw error

      setUpcomingPosts(upcomingPosts.filter(p => p.id !== postId))
      alert('Post approved!')
    } catch (error) {
      console.error('Error approving post:', error)
      alert('Failed to approve post')
    }
  }

  const handleEditPost = async (postId) => {
    try {
      const { error } = await supabase
        .from('social_posts')
        .update({ content: editingPostText })
        .eq('id', postId)

      if (error) throw error

      setEditingPostId(null)
      setEditingPostText('')
      setModalOpen(false)
      alert('Post updated!')
      fetchData()
    } catch (error) {
      console.error('Error updating post:', error)
      alert('Failed to update post')
    }
  }

  const openEditModal = (post) => {
    setEditingPostId(post.id)
    setEditingPostText(post.content)
    setModalOpen(true)
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-teal-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading marketing data...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-4">
              <Link href="/dashboard" className="text-gray-600 hover:text-gray-900">
                <ChevronLeft className="w-5 h-5" />
              </Link>
              <h1 className="text-3xl font-bold text-slate-900">Marketing Dashboard</h1>
            </div>
          </div>

          {/* Date Range Selector */}
          <div className="flex gap-2">
            {['7', '30', '90'].map(days => (
              <button
                key={days}
                onClick={() => setDateRange(days)}
                className={`px-4 py-2 rounded-lg font-medium ${
                  dateRange === days
                    ? 'bg-teal-600 text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                Last {days} days
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Stats Row */}
        {stats && (
          <div className="grid grid-cols-5 gap-4 mb-8">
            <div className="bg-white rounded-lg p-6 border border-gray-200">
              <div className="text-gray-600 text-sm font-medium">Leads Generated</div>
              <div className="text-3xl font-bold text-slate-900 mt-2">{stats.totalLeadsGenerated}</div>
            </div>
            <div className="bg-white rounded-lg p-6 border border-gray-200">
              <div className="text-gray-600 text-sm font-medium">Cost per Lead</div>
              <div className="text-3xl font-bold text-slate-900 mt-2">${stats.costPerLead}</div>
            </div>
            <div className="bg-white rounded-lg p-6 border border-gray-200">
              <div className="text-gray-600 text-sm font-medium">Active Sequences</div>
              <div className="text-3xl font-bold text-orange-600 mt-2">{stats.activeSequences}</div>
            </div>
            <div className="bg-white rounded-lg p-6 border border-gray-200">
              <div className="text-gray-600 text-sm font-medium">Posts Published</div>
              <div className="text-3xl font-bold text-blue-600 mt-2">{stats.postsPublished}</div>
            </div>
            <div className="bg-white rounded-lg p-6 border border-gray-200">
              <div className="text-gray-600 text-sm font-medium">Engagement Rate</div>
              <div className="text-3xl font-bold text-green-600 mt-2">{stats.engagementRate}%</div>
            </div>
          </div>
        )}

        {/* Upcoming Posts Section */}
        {upcomingPosts.length > 0 && (
          <div className="mb-8">
            <h2 className="text-xl font-bold text-slate-900 mb-4">Upcoming Posts (Next 7 Days)</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {upcomingPosts.map(post => (
                <div key={post.id} className="bg-white rounded-lg p-6 border border-gray-200">
                  <div className="mb-4">
                    <p className="text-sm text-gray-600 mb-2">{post.content.substring(0, 80)}...</p>
                    <div className="flex gap-2 mb-4">
                      <span className="inline-block px-2 py-1 bg-blue-100 text-blue-900 rounded text-xs font-medium">
                        {post.post_type}
                      </span>
                      {post.status === 'needs_review' && (
                        <span className="inline-block px-2 py-1 bg-yellow-100 text-yellow-900 rounded text-xs font-medium">
                          Needs Review
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 text-gray-600 text-sm mb-4">
                    <Calendar className="w-4 h-4" />
                    {new Date(post.scheduled_date).toLocaleDateString()}
                  </div>

                  {post.status === 'needs_review' && (
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleApprovePost(post.id)}
                        className="flex-1 inline-flex items-center justify-center gap-2 px-3 py-2 bg-green-600 text-white rounded font-medium hover:bg-green-700"
                      >
                        <Check className="w-4 h-4" />
                        Approve
                      </button>
                      <button
                        onClick={() => openEditModal(post)}
                        className="flex-1 inline-flex items-center justify-center gap-2 px-3 py-2 bg-blue-600 text-white rounded font-medium hover:bg-blue-700"
                      >
                        <Edit2 className="w-4 h-4" />
                        Edit
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Email Performance Section */}
        <div className="mb-8">
          <h2 className="text-xl font-bold text-slate-900 mb-4">Email Performance</h2>
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            {emailPerformance.length === 0 ? (
              <div className="p-12 text-center">
                <p className="text-gray-500">No email sequences yet</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase">
                        Sequence
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase">
                        Variant
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase">
                        Sent
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase">
                        Open Rate
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase">
                        Reply Rate
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase">
                        Meetings
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {emailPerformance.map(seq => (
                      <tr key={seq.id} className="hover:bg-gray-50">
                        <td className="px-6 py-4 font-medium text-slate-900">{seq.sequence_name}</td>
                        <td className="px-6 py-4 text-gray-600">{seq.variant}</td>
                        <td className="px-6 py-4 text-gray-600">{seq.emails_sent}</td>
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-2">
                            <div className="w-24 bg-gray-200 rounded-full h-2">
                              <div
                                className="bg-blue-600 h-2 rounded-full"
                                style={{ width: `${seq.open_rate || 0}%` }}
                              ></div>
                            </div>
                            <span className="text-sm font-medium">{seq.open_rate || 0}%</span>
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-2">
                            <div className="w-24 bg-gray-200 rounded-full h-2">
                              <div
                                className="bg-green-600 h-2 rounded-full"
                                style={{ width: `${seq.reply_rate || 0}%` }}
                              ></div>
                            </div>
                            <span className="text-sm font-medium">{seq.reply_rate || 0}%</span>
                          </div>
                        </td>
                        <td className="px-6 py-4 text-gray-600">{seq.meetings_booked || 0}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* Social Performance Section */}
        <div>
          <h2 className="text-xl font-bold text-slate-900 mb-4">Social Performance (Last 10 Posts)</h2>
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            {socialPosts.length === 0 ? (
              <div className="p-12 text-center">
                <p className="text-gray-500">No published posts yet</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase">
                        Post Preview
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase">
                        Type
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase">
                        Published
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase">
                        Likes
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase">
                        Comments
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase">
                        Shares
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {socialPosts.map(post => (
                      <tr key={post.id} className="hover:bg-gray-50">
                        <td className="px-6 py-4 text-gray-700 max-w-xs truncate">
                          {post.content}
                        </td>
                        <td className="px-6 py-4">
                          <span className="inline-block px-3 py-1 bg-blue-100 text-blue-900 rounded-full text-sm font-medium">
                            {post.post_type}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-gray-600 text-sm">
                          {post.published_at ? new Date(post.published_at).toLocaleDateString() : '-'}
                        </td>
                        <td className="px-6 py-4 font-medium text-slate-900">{post.likes_count || 0}</td>
                        <td className="px-6 py-4 font-medium text-slate-900">{post.comments_count || 0}</td>
                        <td className="px-6 py-4 font-medium text-slate-900">{post.shares_count || 0}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Edit Post Modal */}
      {modalOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-8 max-w-2xl w-full mx-4">
            <h2 className="text-2xl font-bold text-slate-900 mb-6">Edit Post</h2>
            <textarea
              value={editingPostText}
              onChange={(e) => setEditingPostText(e.target.value)}
              className="w-full p-4 border border-gray-300 rounded-lg focus:ring-2 focus:ring-teal-500 focus:border-transparent mb-6"
              rows="10"
            ></textarea>
            <div className="flex gap-3">
              <button
                onClick={() => handleEditPost(editingPostId)}
                className="flex-1 px-4 py-2 bg-teal-600 text-white rounded-lg font-medium hover:bg-teal-700"
              >
                Save Changes
              </button>
              <button
                onClick={() => {
                  setModalOpen(false)
                  setEditingPostId(null)
                  setEditingPostText('')
                }}
                className="flex-1 px-4 py-2 border border-gray-300 rounded-lg font-medium hover:bg-gray-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
