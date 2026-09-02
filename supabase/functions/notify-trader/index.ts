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

const STATUS_MESSAGES: Record<string, { title: string; body: string }> = {
  countered:  { title: 'Counter offer received', body: 'A driver has made a counter offer on your job' },
  accepted:   { title: 'Job accepted!',           body: 'A driver has accepted your job and will be on the way' },
  on_the_way: { title: 'Driver on the way',       body: 'Your driver is heading to you now' },
  completed:  { title: 'Job complete',            body: 'Your load has been delivered' },
}

Deno.serve(async (req) => {
  try {
    const { record, old_record } = await req.json()

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const accessToken = await getAccessToken()
    const projectId = FIREBASE_SERVICE_ACCOUNT.project_id

    // Trader accepted the driver's counter offer: notify the driver too. Don't
    // return — fall through so the trader still gets the 'accepted' push below.
    if (record.status === 'accepted' && old_record?.status === 'countered' && record.driver_id) {
      const { data: driver, error } = await supabase
        .from('users').select('fcm_token').eq('id', record.driver_id).single()
      if (error) throw error
      console.log('[notify-trader] branch=counter-accepted → driver', record.driver_id, 'fcm_token=', driver?.fcm_token || 'none')
      if (driver?.fcm_token) {
        await sendPush(
          driver.fcm_token,
          'Counter offer accepted',
          'The trader accepted your price — head to the pickup',
          projectId, accessToken
        )
      }
    }

    // Status reverted to 'posted' with driver_id cleared. Same shape whether the
    // trader declined a counter, the trader marked the driver as a no-show, or
    // the driver cancelled their own job — distinguish by old_record.status
    // (countered takes priority) and record.cancelled_by.
    if (record.status === 'posted' && old_record?.driver_id && !record.driver_id) {
      // A declined counter is a different case and takes priority.
      if (old_record.status === 'countered') {
        const { data: driver, error } = await supabase
          .from('users').select('fcm_token').eq('id', old_record.driver_id).single()
        if (error) throw error
        console.log('[notify-trader] branch=posted/counter-declined → driver', old_record.driver_id, 'fcm_token=', driver?.fcm_token || 'none')
        if (!driver?.fcm_token) {
          return new Response(JSON.stringify({ message: 'Driver has no fcm_token' }), { status: 200 })
        }
        const result = await sendPush(
          driver.fcm_token,
          'Counter offer declined',
          'The trader declined your counter offer',
          projectId, accessToken
        )
        return new Response(JSON.stringify({ sent: result }), { status: 200 })
      }

      if (record.cancelled_by === 'driver') {
        // The driver cancelled their own job — notify the trader, not the driver.
        const { data: trader, error } = await supabase
          .from('users').select('fcm_token').eq('id', record.trader_id).single()
        if (error) throw error
        console.log('[notify-trader] branch=posted/driver-cancelled → trader', record.trader_id, 'fcm_token=', trader?.fcm_token || 'none')
        if (!trader?.fcm_token) {
          return new Response(JSON.stringify({ message: 'Trader has no fcm_token' }), { status: 200 })
        }
        const result = await sendPush(
          trader.fcm_token,
          'Driver cancelled',
          'Your driver cancelled — your job is live again for other drivers',
          projectId, accessToken
        )
        return new Response(JSON.stringify({ sent: result }), { status: 200 })
      }

      if (record.cancelled_by === 'trader') {
        // The trader marked the driver as a no-show — notify the driver.
        const { data: driver, error } = await supabase
          .from('users').select('fcm_token').eq('id', old_record.driver_id).single()
        if (error) throw error
        console.log('[notify-trader] branch=posted/no-show → driver', old_record.driver_id, 'fcm_token=', driver?.fcm_token || 'none')
        if (!driver?.fcm_token) {
          return new Response(JSON.stringify({ message: 'Driver has no fcm_token' }), { status: 200 })
        }
        const result = await sendPush(
          driver.fcm_token,
          'Marked as not arrived',
          'The trader marked you as not arrived — the job has been offered to other drivers',
          projectId, accessToken
        )
        return new Response(JSON.stringify({ sent: result }), { status: 200 })
      }

      console.log('[notify-trader] branch=posted/other old_status=' + old_record.status + ' cancelled_by=' + record.cancelled_by + ' — no notification')
      return new Response(JSON.stringify({ message: 'Re-posted from ' + old_record.status + ' — no notification' }), { status: 200 })
    }

    // Job cancelled (soft): notify the assigned driver. driver_id is kept on cancel.
    if (record.status === 'cancelled') {
      const driverId = record.driver_id || old_record?.driver_id
      if (!driverId) {
        console.log('[notify-trader] branch=cancelled — no driver assigned, nothing to notify')
        return new Response(JSON.stringify({ message: 'Cancelled with no driver assigned' }), { status: 200 })
      }
      const { data: driver, error } = await supabase
        .from('users').select('fcm_token').eq('id', driverId).single()
      if (error) throw error
      console.log('[notify-trader] branch=cancelled → driver', driverId, 'fcm_token=', driver?.fcm_token || 'none')
      if (!driver?.fcm_token) {
        return new Response(JSON.stringify({ message: 'Driver has no fcm_token' }), { status: 200 })
      }
      const result = await sendPush(
        driver.fcm_token,
        'Job cancelled',
        'The trader has cancelled this job',
        projectId, accessToken
      )
      return new Response(JSON.stringify({ sent: result }), { status: 200 })
    }

    // All other statuses — notify trader
    const message = STATUS_MESSAGES[record.status]
    if (!message) {
      return new Response(JSON.stringify({ message: 'No notification for this status' }), { status: 200 })
    }

    const { data: trader, error } = await supabase
      .from('users').select('fcm_token').eq('id', record.trader_id).single()

    if (error) throw error
    console.log('[notify-trader] branch=status/' + record.status + ' → trader', record.trader_id, 'fcm_token=', trader?.fcm_token || 'none')
    if (!trader?.fcm_token) {
      return new Response(JSON.stringify({ message: 'Trader has no fcm_token' }), { status: 200 })
    }

    const result = await sendPush(trader.fcm_token, message.title, message.body, projectId, accessToken)

    return new Response(JSON.stringify({ sent: result }), { status: 200 })
  } catch (err) {
    console.error(err)
    return new Response(JSON.stringify({ error: err.message }), { status: 500 })
  }
})
