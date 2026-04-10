import React, { useEffect, useRef, useState, createContext, useContext } from 'react';
import { StyleSheet, ActivityIndicator, View, TouchableOpacity, Alert } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';

import { supabase } from './src/services/supabase';
import LoginScreen from './src/screens/LoginScreen';
import DashboardScreen from './src/screens/DashboardScreen';
import PendingPostsScreen from './src/screens/PendingPostsScreen';
import PostDetailScreen from './src/screens/PostDetailScreen';
import PostedHistoryScreen from './src/screens/PostedHistoryScreen';
import ClientsScreen from './src/screens/ClientsScreen';
import ClientDetailScreen from './src/screens/ClientDetailScreen';
import {
  registerForPushNotifications,
  setupNotificationResponseHandler,
  clearBadge,
} from './src/services/notifications';

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

// ─── Brand tokens ────────────────────────────────
const navy    = '#0B1A2E';
const brand   = '#2E8B57';
const gray400 = '#919EAB';
const gray150 = '#EAEDF0';
const white   = '#FFFFFF';
const bg      = '#F4F6F8';

// ─── Auth context so logout works from any screen ─
const AuthContext = createContext(null);

function LogoutButton() {
  const { logout } = useContext(AuthContext);

  const handlePress = () => {
    Alert.alert('Log Out', 'Are you sure you want to log out?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Log Out',
        style: 'destructive',
        onPress: logout,
      },
    ]);
  };

  return (
    <TouchableOpacity onPress={handlePress} style={{ paddingVertical: 6, paddingHorizontal: 16 }}>
      <Ionicons name="log-out-outline" size={22} color="#A5D6A7" />
    </TouchableOpacity>
  );
}

const stackScreenOptions = {
  headerStyle: { backgroundColor: navy },
  headerTintColor: white,
  headerTitleStyle: { fontWeight: '600', fontSize: 17, letterSpacing: -0.3 },
  headerShadowVisible: false,
  headerBackTitleVisible: false,
  contentStyle: { backgroundColor: bg },
  headerRight: () => <LogoutButton />,
};

function HomeStack() {
  return (
    <Stack.Navigator screenOptions={stackScreenOptions}>
      <Stack.Screen
        name="Dashboard"
        component={DashboardScreen}
        options={{ title: 'WellMor' }}
      />
      <Stack.Screen
        name="PostDetail"
        component={PostDetailScreen}
        options={{ title: 'Post Details' }}
      />
    </Stack.Navigator>
  );
}

function PendingStack() {
  return (
    <Stack.Navigator screenOptions={stackScreenOptions}>
      <Stack.Screen
        name="PendingList"
        component={PendingPostsScreen}
        options={{ title: 'Pending Approval' }}
      />
      <Stack.Screen
        name="PostDetail"
        component={PostDetailScreen}
        options={{ title: 'Post Details' }}
      />
    </Stack.Navigator>
  );
}

function HistoryStack() {
  return (
    <Stack.Navigator screenOptions={stackScreenOptions}>
      <Stack.Screen
        name="PostedList"
        component={PostedHistoryScreen}
        options={{ title: 'Published' }}
      />
      <Stack.Screen
        name="PostDetail"
        component={PostDetailScreen}
        options={{ title: 'Post Details' }}
      />
    </Stack.Navigator>
  );
}

function ClientsStack() {
  return (
    <Stack.Navigator screenOptions={stackScreenOptions}>
      <Stack.Screen
        name="ClientsList"
        component={ClientsScreen}
        options={{ title: 'Clients' }}
      />
      <Stack.Screen
        name="ClientDetail"
        component={ClientDetailScreen}
        options={({ route }) => ({ title: route.params?.clientName || 'Client' })}
      />
    </Stack.Navigator>
  );
}

export default function App() {
  const navigationRef = useRef(null);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [checkingAuth, setCheckingAuth] = useState(true);

  const logout = async () => {
    await supabase.auth.signOut();
    setIsLoggedIn(false);
  };

  useEffect(() => {
    // Check existing session on mount
    supabase.auth.getSession().then(({ data: { session } }) => {
      setIsLoggedIn(!!session);
      setCheckingAuth(false);
    });

    // Listen for auth state changes (login, logout, token refresh)
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setIsLoggedIn(!!session);
    });

    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (isLoggedIn) {
      registerForPushNotifications().catch(() => {});
      clearBadge();
      const subscription = setupNotificationResponseHandler(navigationRef.current);
      return () => {
        if (subscription) subscription.remove();
      };
    }
  }, [isLoggedIn]);

  if (checkingAuth) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: white }}>
        <ActivityIndicator size="large" color={brand} />
      </View>
    );
  }

  if (!isLoggedIn) {
    return (
      <>
        <StatusBar style="dark" />
        <LoginScreen onLogin={() => setIsLoggedIn(true)} />
      </>
    );
  }

  return (
    <AuthContext.Provider value={{ logout }}>
      <NavigationContainer ref={navigationRef}>
        <StatusBar style="light" />
        <Tab.Navigator
          screenOptions={({ route }) => ({
            headerShown: false,
            tabBarIcon: ({ focused, color, size }) => {
              let iconName;
              if (route.name === 'Home') {
                iconName = focused ? 'grid' : 'grid-outline';
              } else if (route.name === 'PendingPosts') {
                iconName = focused ? 'document-text' : 'document-text-outline';
              } else if (route.name === 'PostedHistory') {
                iconName = focused ? 'checkmark-done-circle' : 'checkmark-done-circle-outline';
              } else if (route.name === 'Clients') {
                iconName = focused ? 'people' : 'people-outline';
              }
              return <Ionicons name={iconName} size={22} color={color} />;
            },
            tabBarActiveTintColor: brand,
            tabBarInactiveTintColor: gray400,
            tabBarStyle: {
              backgroundColor: white,
              borderTopWidth: StyleSheet.hairlineWidth || 0.5,
              borderTopColor: gray150,
              paddingTop: 6,
              paddingBottom: 6,
              height: 88,
            },
            tabBarLabelStyle: {
              fontSize: 10,
              fontWeight: '600',
              letterSpacing: 0.3,
              marginTop: 2,
            },
          })}
        >
          <Tab.Screen
            name="Home"
            component={HomeStack}
            options={{ tabBarLabel: 'Home' }}
          />
          <Tab.Screen
            name="PendingPosts"
            component={PendingStack}
            options={{ tabBarLabel: 'Pending' }}
          />
          <Tab.Screen
            name="PostedHistory"
            component={HistoryStack}
            options={{ tabBarLabel: 'Published' }}
          />
          <Tab.Screen
            name="Clients"
            component={ClientsStack}
            options={{ tabBarLabel: 'Clients' }}
          />
        </Tab.Navigator>
      </NavigationContainer>
    </AuthContext.Provider>
  );
}
