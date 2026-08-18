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

    // Cancellation: determine who cancelled and notify the other party
    if (record.status === 'cancelled') {
      const driverWasAssigned = !!old_record?.driver_id
      const driverWasCleared  = driverWasAssigned && !record.driver_id

      if (driverWasCleared) {
        // Driver cancelled — notify trader
        const { data: trader, error } = await supabase
          .from('users').select('fcm_token').eq('id', record.trader_id).single()
        if (error) throw error
        if (!trader?.fcm_token) {
          return new Response(JSON.stringify({ message: 'Trader has no fcm_token' }), { status: 200 })
        }
        const result = await sendPush(
          trader.fcm_token,
          'Driver cancelled',
          'Your driver has cancelled — you can post the job again',
          projectId, accessToken
        )
        return new Response(JSON.stringify({ sent: result }), { status: 200 })
      } else if (driverWasAssigned) {
        // Trader cancelled while driver was assigned — notify driver
        const { data: driver, error } = await supabase
          .from('users').select('fcm_token').eq('id', old_record.driver_id).single()
        if (error) throw error
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

      return new Response(JSON.stringify({ message: 'Cancelled with no driver assigned — no notification needed' }), { status: 200 })
    }

    // All other statuses — notify trader
    const message = STATUS_MESSAGES[record.status]
    if (!message) {
      return new Response(JSON.stringify({ message: 'No notification for this status' }), { status: 200 })
    }

    const { data: trader, error } = await supabase
      .from('users').select('fcm_token').eq('id', record.trader_id).single()

    if (error) throw error
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
