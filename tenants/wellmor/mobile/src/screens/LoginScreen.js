import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, Alert,
  KeyboardAvoidingView, Platform, ActivityIndicator, Image,
} from 'react-native';
import { supabase } from '../services/supabase';

// Username-to-email mapping so owners can log in with a simple username
const USERNAME_MAP = {
  owner: 'morgan@wellmorbenefits.com',
};

export default function LoginScreen({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleLogin = async () => {
    const trimmed = username.trim().toLowerCase();
    if (!trimmed || !password) {
      Alert.alert('Missing Fields', 'Please enter your username and password.');
      return;
    }

    // Resolve username to email, or treat input as email if not mapped
    const email = USERNAME_MAP[trimmed] || trimmed;

    setLoading(true);
    setError(null);

    try {
      const { error: authError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (authError) {
        setError('Invalid username or password. Please try again.');
        setLoading(false);
        return;
      }

      setLoading(false);
      onLogin();
    } catch (err) {
      setError(err.message || 'Something went wrong. Please try again.');
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: '#FFFFFF' }}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={{ flex: 1, justifyContent: 'center', paddingHorizontal: 28, marginTop: -80 }}>
        {/* Logo */}
        <View style={{ alignItems: 'center', marginBottom: 16 }}>
          <Image
            source={require('../../assets/logo.png')}
            style={{ width: 364, height: 364 }}
            resizeMode="contain"
          />
        </View>

        {/* Error message */}
        {error && (
          <View style={{
            backgroundColor: '#FEF2F2', borderWidth: 1, borderColor: '#FECACA',
            padding: 12, borderRadius: 12, marginBottom: 16,
          }}>
            <Text style={{ color: '#DC2626', fontSize: 14, textAlign: 'center', fontWeight: '600' }}>{error}</Text>
          </View>
        )}

        {/* Form */}
        <View style={{ gap: 14 }}>
          <View>
            <Text style={{ fontSize: 13, fontWeight: '600', color: '#374151', marginBottom: 6, marginLeft: 4 }}>
              Username
            </Text>
            <TextInput
              value={username}
              onChangeText={setUsername}
              placeholder="Enter your username"
              placeholderTextColor="#9CA3AF"
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="username"
              style={{
                backgroundColor: '#F9FAFB',
                borderWidth: 1.5,
                borderColor: '#E5E7EB',
                borderRadius: 14,
                padding: 16,
                fontSize: 16,
                color: '#111827',
              }}
            />
          </View>

          <View>
            <Text style={{ fontSize: 13, fontWeight: '600', color: '#374151', marginBottom: 6, marginLeft: 4 }}>
              Password
            </Text>
            <View style={{ position: 'relative' }}>
              <TextInput
                value={password}
                onChangeText={setPassword}
                placeholder="Enter your password"
                placeholderTextColor="#9CA3AF"
                secureTextEntry={!showPassword}
                textContentType="password"
                style={{
                  backgroundColor: '#F9FAFB',
                  borderWidth: 1.5,
                  borderColor: '#E5E7EB',
                  borderRadius: 14,
                  padding: 16,
                  paddingRight: 60,
                  fontSize: 16,
                  color: '#111827',
                }}
              />
              <TouchableOpacity
                onPress={() => setShowPassword(!showPassword)}
                style={{
                  position: 'absolute',
                  right: 16,
                  top: 0,
                  bottom: 0,
                  justifyContent: 'center',
                }}
              >
                <Text style={{ fontSize: 14, fontWeight: '700', color: '#6B7280' }}>
                  {showPassword ? 'Hide' : 'Show'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* Login Button */}
          <TouchableOpacity
            onPress={handleLogin}
            disabled={loading}
            activeOpacity={0.8}
            style={{
              backgroundColor: '#2E8B57',
              borderRadius: 14,
              paddingVertical: 16,
              alignItems: 'center',
              marginTop: 12,
              shadowColor: '#2E8B57',
              shadowOffset: { width: 0, height: 4 },
              shadowOpacity: 0.3,
              shadowRadius: 8,
            }}
          >
            {loading ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={{ fontSize: 17, fontWeight: '800', color: '#FFFFFF' }}>
                Sign In
              </Text>
            )}
          </TouchableOpacity>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}
