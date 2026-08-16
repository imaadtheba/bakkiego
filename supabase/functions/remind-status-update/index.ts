import { createClient } from 'jsr:@supabase/supabase-js@2'

const FIREBASE_SERVICE_ACCOUNT = JSON.parse(Deno.env.get('FIREBASE_SERVICE_ACCOUNT')!)

async function getAccessToken() {
  const { GoogleAuth } = await import('npm:google-auth-library@9')
  const auth = new GoogleAuth({
    credentials: FIREBASE_SERVICE_ACCOUNT,
    scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
  })
  const client = await auth.getClient()
  const token = await client.getAccessToken()
  return token.token
}

async function sendPush(fcmToken: string, title: string, body: string, projectId: string, accessToken: string) {
  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          token: fcmToken,
          notification: { title, body },
        },
      }),
    }
  )
  return res.json()
}

const DRIVER_REMINDERS: Record<string, { thresholdMins: number; title: string; body: string }> = {
  accepted:    { thresholdMins: 5,  title: 'Update your status',  body: "Are you on your way? Don't forget to update your status" },
  on_the_way:  { thresholdMins: 5,  title: 'Update your status',  body: 'Have you picked up the load? Tap to update your status' },
  in_progress: { thresholdMins: 15, title: 'Complete your job',   body: 'Have you collected cash and delivered? Tap to complete the job' },
}

const TRADER_IN_PROGRESS = {
  thresholdMins: 20,
  title: 'Delivery check',
  body: 'Has your load been delivered? Tap to confirm delivery',
}

Deno.serve(async () => {
  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    // Auto-expire jobs stuck in on_the_way/in_progress for more than 8 hours
    const expiryCutoff = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString()
    const now = new Date().toISOString()
    const { error: expireError } = await supabase
      .from('jobs')
      .update({ status: 'completed', completed_at: now })
      .in('status', ['on_the_way', 'in_progress'])
      .lt('updated_at', expiryCutoff)
    if (expireError) console.error('[remind-status-update] auto-expire error:', expireError)
    else console.log('[remind-status-update] auto-expire ran OK')

    // Fetch all active jobs older than the minimum threshold (5 min)
    const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    const { data: jobs, error } = await supabase
      .from('jobs')
      .select('id, status, updated_at, driver:users!driver_id(fcm_token), trader:users!trader_id(fcm_token)')
      .in('status', ['accepted', 'on_the_way', 'in_progress'])
      .lt('updated_at', cutoff)

    if (error) throw error
    if (!jobs || jobs.length === 0) {
      return new Response(JSON.stringify({ message: 'No stale jobs found' }), { status: 200 })
    }

    const accessToken = await getAccessToken()
    const projectId = FIREBASE_SERVICE_ACCOUNT.project_id
    const pushes: Promise<unknown>[] = []

    for (const job of jobs) {
      const ageMin = (Date.now() - new Date(job.updated_at).getTime()) / 60000

      // Driver reminder
      const driverReminder = DRIVER_REMINDERS[job.status]
      if (driverReminder && ageMin > driverReminder.thresholdMins) {
        const fcm = (job.driver as { fcm_token?: string } | null)?.fcm_token
        if (fcm) {
          pushes.push(sendPush(fcm, driverReminder.title, driverReminder.body, projectId, accessToken))
        }
      }

      // Trader reminder for in_progress > 20 min
      if (job.status === 'in_progress' && ageMin > TRADER_IN_PROGRESS.thresholdMins) {
        const fcm = (job.trader as { fcm_token?: string } | null)?.fcm_token
        if (fcm) {
          pushes.push(sendPush(fcm, TRADER_IN_PROGRESS.title, TRADER_IN_PROGRESS.body, projectId, accessToken))
        }
      }
    }

    const results = await Promise.allSettled(pushes)
    const sent    = results.filter(r => r.status === 'fulfilled').length
    const failed  = results.filter(r => r.status === 'rejected').length
    console.log(`[remind-status-update] sent=${sent} failed=${failed}`)

    return new Response(JSON.stringify({ sent, failed }), { status: 200 })
  } catch (err) {
    console.error(err)
    return new Response(JSON.stringify({ error: err.message }), { status: 500 })
  }
})
