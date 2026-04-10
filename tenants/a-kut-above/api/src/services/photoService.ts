import { supabase } from '../config/supabase';
import { v4 as uuidv4 } from 'uuid';
import { aiService } from './aiService';

export const photoService = {
  async upload(leadId: string, photoType: 'before' | 'after' | 'extra_1' | 'extra_2', file: Express.Multer.File) {
    // Delete any existing photo of the same type for this lead (replace behavior)
    const { data: existing } = await supabase
      .from('job_photos')
      .select('id, storage_path')
      .eq('lead_id', leadId)
      .eq('photo_type', photoType);

    if (existing && existing.length > 0) {
      const storagePaths = existing.map(p => p.storage_path).filter(Boolean);
      if (storagePaths.length > 0) {
        await supabase.storage.from('job-photos').remove(storagePaths);
      }
      const ids = existing.map(p => p.id);
      await supabase.from('job_photos').delete().in('id', ids);
    }

    const fileExt = file.originalname.split('.').pop();
    const fileName = `${leadId}/${photoType}_${uuidv4()}.${fileExt}`;

    const { error: uploadError } = await supabase.storage
      .from('job-photos')
      .upload(fileName, file.buffer, {
        contentType: file.mimetype,
      });

    if (uploadError) throw uploadError;

    const { data: { publicUrl } } = supabase.storage
      .from('job-photos')
      .getPublicUrl(fileName);

    // Get lead info for caption generation
    const { data: lead } = await supabase
      .from('leads')
      .select('service_type, notes')
      .eq('id', leadId)
      .single();

    // Generate AI caption
    let caption = '';
    try {
      caption = await aiService.generateCaption(
        photoType,
        lead?.service_type || 'tree_service',
        lead?.notes
      );
    } catch (e) {
      console.error('Caption generation failed:', e);
    }

    const { data: photo, error } = await supabase
      .from('job_photos')
      .insert({
        lead_id: leadId,
        photo_type: photoType,
        storage_path: fileName,
        public_url: publicUrl,
        caption,
      })
      .select()
      .single();

    if (error) throw error;
    return photo;
  },

  async getByLead(leadId: string) {
    const { data, error } = await supabase
      .from('job_photos')
      .select('*')
      .eq('lead_id', leadId)
      .order('created_at');

    if (error) throw error;
    return data;
  },

  async getAllPhotos(limit: number = 50) {
    const { data, error } = await supabase
      .from('job_photos')
      .select('*, leads(name, service_type)')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return data;
  },

  async deleteAllForLead(leadId: string) {
    const { data: photos } = await supabase
      .from('job_photos')
      .select('id, storage_path')
      .eq('lead_id', leadId);

    if (photos && photos.length > 0) {
      const storagePaths = photos.map(p => p.storage_path).filter(Boolean);
      if (storagePaths.length > 0) {
        await supabase.storage.from('job-photos').remove(storagePaths);
      }
      await supabase.from('job_photos').delete().eq('lead_id', leadId);
    }
  },

  async delete(photoId: string) {
    const { data: photo } = await supabase
      .from('job_photos')
      .select('storage_path')
      .eq('id', photoId)
      .single();

    if (photo?.storage_path) {
      await supabase.storage.from('job-photos').remove([photo.storage_path]);
    }

    const { error } = await supabase
      .from('job_photos')
      .delete()
      .eq('id', photoId);

    if (error) throw error;
  },
};
