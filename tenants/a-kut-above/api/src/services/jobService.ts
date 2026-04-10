import { supabase } from '../config/supabase';

export const jobService = {
  async getWonJobs(limit: number = 20, offset: number = 0) {
    const { data, error, count } = await supabase
      .from('leads')
      .select('*, job_photos(*)', { count: 'exact' })
      .eq('status', 'won')
      .order('updated_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;
    return { jobs: data, count };
  },

  async getJobsWithPhotos() {
    const { data, error } = await supabase
      .from('leads')
      .select('*, job_photos(*)')
      .not('job_photos', 'is', null)
      .order('updated_at', { ascending: false });

    if (error) throw error;
    return data?.filter(lead => lead.job_photos && lead.job_photos.length > 0) || [];
  },

  async getBeforeAfterPairs() {
    const { data, error } = await supabase
      .from('leads')
      .select('id, name, service_type, notes, job_photos(*)')
      .eq('status', 'won');

    if (error) throw error;

    return (data || []).filter(job => {
      const photos = job.job_photos || [];
      const hasBefore = photos.some((p: any) => p.photo_type === 'before');
      const hasAfter = photos.some((p: any) => p.photo_type === 'after');
      return hasBefore && hasAfter;
    }).map(job => {
      const photos = job.job_photos || [];
      return {
        ...job,
        before_photo: photos.find((p: any) => p.photo_type === 'before'),
        after_photo: photos.find((p: any) => p.photo_type === 'after'),
      };
    });
  },
};
