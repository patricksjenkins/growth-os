'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'

/**
 * Updated Navigation component for BenefitsIQ with Growth System section
 * Shows nav links and approval queue badge
 */
export default function Navigation() {
  const [approvalQueueCount, setApprovalQueueCount] = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchApprovalCount()
    // Refresh every 30 seconds
    const interval = setInterval(fetchApprovalCount, 30000)
    return () => clearInterval(interval)
  }, [])

  const fetchApprovalCount = async () => {
    try {
      const { data, error } = await supabase
        .from('leads_pipeline_view')
        .select('id', { count: 'exact' })
        .eq('priority_tier', 'B')
        .eq('outreach_approved', false)

      if (error) throw error

      setApprovalQueueCount(data?.length || 0)
    } catch (error) {
      console.error('Error fetching approval count:', error)
    } finally {
      setLoading(false)
    }
  }

  return (
    <nav className="bg-slate-900 text-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Logo */}
          <div className="flex-shrink-0">
            <Link href="/dashboard" className="text-xl font-bold">
              BenefitsIQ
            </Link>
          </div>

          {/* Navigation Links */}
          <div className="flex gap-8">
            {/* Growth System Section */}
            <div className="group relative">
              <button className="py-2 px-1 border-b-2 border-transparent hover:border-teal-500 font-medium text-sm">
                Growth System
              </button>

              {/* Dropdown Menu */}
              <div className="absolute left-0 mt-0 w-48 bg-slate-800 rounded-lg shadow-xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 py-2 z-50">
                <Link
                  href="/prospects"
                  className="block px-4 py-2 text-gray-100 hover:bg-slate-700 hover:text-white font-medium text-sm"
                >
                  Prospect Pipeline
                </Link>

                <Link
                  href="/marketing"
                  className="block px-4 py-2 text-gray-100 hover:bg-slate-700 hover:text-white font-medium text-sm"
                >
                  Marketing Dashboard
                </Link>

                <Link
                  href="/meetings"
                  className="block px-4 py-2 text-gray-100 hover:bg-slate-700 hover:text-white font-medium text-sm"
                >
                  Meetings
                </Link>

                {/* Separator */}
                <div className="border-t border-slate-600 my-2"></div>

                {/* Approval Queue Badge */}
                <div className="px-4 py-2 text-gray-400 text-xs font-medium">
                  <p className="mb-2">APPROVAL QUEUE</p>
                  {!loading && approvalQueueCount > 0 && (
                    <div className="inline-block px-2 py-1 bg-yellow-600 text-white rounded-full text-xs font-bold">
                      {approvalQueueCount} pending
                    </div>
                  )}
                  {!loading && approvalQueueCount === 0 && (
                    <p className="text-gray-500 text-xs">All caught up!</p>
                  )}
                </div>
              </div>
            </Link>
          </div>

          {/* Right Side Items */}
          <div className="flex items-center gap-6">
            <Link href="/dashboard" className="text-gray-300 hover:text-white text-sm font-medium">
              Dashboard
            </Link>
            <button className="w-10 h-10 bg-teal-600 rounded-full hover:bg-teal-700 font-medium">
              M
            </button>
          </div>
        </div>
      </div>
    </nav>
  )
}
