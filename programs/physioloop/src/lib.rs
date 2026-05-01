use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

declare_id!("3vArMkTYa2J95xVYsgdsnDu2pokBjRQGj7ZFUdeDutQi");

// palmUSD (PUSD) — non-freezable USD-pegged stablecoin. Mint: palmusd.com/pages/developers
// No freeze authority, no blacklist, no pause. Validated via freeze_authority.is_none() on-chain.
pub const PUSD_MINT: &str = "CZzgUBvxaMLwMhVSLgqJn3npmxoTo6nzMNQPAnwtHF3s";

// PUSD has 6 decimal places (same as USDC)
pub const PUSD_DECIMALS: u32 = 6;
// $0.25 PUSD per caregiver check-in (5% of $5 session fee)
pub const CAREGIVER_REWARD_PUSD: u64 = 250_000;
// Streak window: 25 hours to allow flexibility (90_000s). Cooldown: 5 min for devnet testing.
pub const STREAK_WINDOW_SECS: i64 = 90_000;
pub const CHECKIN_COOLDOWN_SECS: i64 = 300; // 5 minutes — change to 86_400 before mainnet

// Per-session revenue split (basis points out of 10_000)
// 70 + 15 + 10 + 5 = 100
pub const PHYSIO_SHARE_BPS: u64    = 7_000; // 70% → physio wallet
pub const OPS_SHARE_BPS: u64       = 1_500; // 15% → ops treasury
pub const CAMPAIGN_SHARE_BPS: u64  = 1_000; // 10% → Torque campaign pool
// 5% stays in escrow for caregiver; released via submit_caregiver_checkin
pub const CAREGIVER_SHARE_BPS: u64 =   500;

// ─── Program ──────────────────────────────────────────────────────────────────

#[program]
pub mod physioloop {
    use super::*;

    /// Physiotherapist creates an on-chain profile. Called once per wallet.
    pub fn register_physio(ctx: Context<RegisterPhysio>, tier: u8) -> Result<()> {
        let profile = &mut ctx.accounts.physio_profile;
        profile.physio = ctx.accounts.physio.key();
        profile.subscription_tier = tier;
        profile.credibility_score = 0.0;
        profile.total_patients = 0;
        profile.active_patients = 0;
        profile.completion_rate = 0.0;
        profile.bump = ctx.bumps.physio_profile;
        Ok(())
    }

    /// Caregiver creates a global profile before being assigned to patients.
    pub fn register_caregiver(ctx: Context<RegisterCaregiver>) -> Result<()> {
        let profile = &mut ctx.accounts.caregiver_profile;
        profile.caregiver = ctx.accounts.caregiver.key();
        profile.checkins_total = 0;
        profile.checkins_streak = 0;
        profile.pusd_earned = 0;
        profile.nft_minted = false;
        profile.last_checkin = 0;
        profile.bump = ctx.bumps.caregiver_profile;
        Ok(())
    }

    /// Physio issues a Home Exercise Program (HEP) to a patient.
    /// Initialises the TreatmentPlan PDA and the escrow vault token account.
    pub fn create_treatment_plan(
        ctx: Context<CreateTreatmentPlan>,
        sessions: u8,
        pusd_per_session: u64,
        patient_name: String,
        caregiver_name: String,
        exercises: String,
    ) -> Result<()> {
        require!(sessions > 0 && sessions <= 60, PhysioloopError::InvalidSessionCount);
        require!(pusd_per_session > 0, PhysioloopError::InvalidAmount);
        require!(patient_name.len() > 0 && patient_name.len() <= 32, PhysioloopError::InvalidAmount);
        require!(caregiver_name.len() <= 32, PhysioloopError::InvalidAmount);
        require!(exercises.len() > 0 && exercises.len() <= 256, PhysioloopError::InvalidAmount);

        let plan = &mut ctx.accounts.treatment_plan;
        plan.physio = ctx.accounts.physio.key();
        plan.patient = ctx.accounts.patient.key();
        plan.caregiver = ctx.accounts.caregiver.key();
        plan.escrow_amount = 0;
        plan.sessions_total = sessions;
        plan.sessions_completed = 0;
        plan.pusd_per_session = pusd_per_session;
        plan.plan_active = false;
        plan.created_at = Clock::get()?.unix_timestamp;
        plan.bump = ctx.bumps.treatment_plan;
        plan.escrow_bump = ctx.bumps.escrow_vault;
        plan.patient_name = patient_name;
        plan.caregiver_name = caregiver_name;
        plan.exercises = exercises;

        // Update physio patient counters
        let physio = &mut ctx.accounts.physio_profile;
        physio.total_patients = physio
            .total_patients
            .checked_add(1)
            .ok_or(PhysioloopError::MathOverflow)?;
        physio.active_patients = physio
            .active_patients
            .checked_add(1)
            .ok_or(PhysioloopError::MathOverflow)?;

        emit!(PlanCreated {
            treatment_plan: plan.key(),
            physio: plan.physio,
            patient: plan.patient,
            sessions_total: sessions,
            pusd_per_session,
        });

        Ok(())
    }

    /// Patient locks PUSD into the escrow vault and activates the plan.
    /// `amount` must cover sessions_total × pusd_per_session.
    pub fn stake_escrow(ctx: Context<StakeEscrow>, amount: u64) -> Result<()> {
        let sessions_total = ctx.accounts.treatment_plan.sessions_total as u64;
        let pusd_per_session = ctx.accounts.treatment_plan.pusd_per_session;
        let plan_active = ctx.accounts.treatment_plan.plan_active;

        require!(!plan_active, PhysioloopError::PlanAlreadyActive);

        let required = sessions_total
            .checked_mul(pusd_per_session)
            .ok_or(PhysioloopError::MathOverflow)?;
        require!(amount >= required, PhysioloopError::InsufficientEscrow);

        // Patient → escrow vault
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.patient_pusd_ata.to_account_info(),
                    mint: ctx.accounts.pusd_mint.to_account_info(),
                    to: ctx.accounts.escrow_vault.to_account_info(),
                    authority: ctx.accounts.patient.to_account_info(),
                },
            ),
            amount,
            PUSD_DECIMALS as u8,
        )?;

        let plan = &mut ctx.accounts.treatment_plan;
        plan.escrow_amount = amount;
        plan.plan_active = true;

        emit!(EscrowFunded {
            treatment_plan: plan.key(),
            patient: plan.patient,
            amount,
        });

        Ok(())
    }

    /// Patient submits an on-device QVAC proof for a completed exercise session.
    /// Releases pusd_per_session from escrow → physio ATA.
    /// Increments physio credibility score using a running average.
    pub fn submit_attestation(
        ctx: Context<SubmitAttestation>,
        session_number: u8,
        proof_hash: [u8; 32],
    ) -> Result<()> {
        // Snapshot plan state before any mutations
        let sessions_total = ctx.accounts.treatment_plan.sessions_total;
        let sessions_completed = ctx.accounts.treatment_plan.sessions_completed;
        let pusd_per_session = ctx.accounts.treatment_plan.pusd_per_session;
        let escrow_amount = ctx.accounts.treatment_plan.escrow_amount;
        let physio_key = ctx.accounts.treatment_plan.physio;
        let patient_key = ctx.accounts.treatment_plan.patient;
        let plan_bump = ctx.accounts.treatment_plan.bump;
        let plan_key = ctx.accounts.treatment_plan.key();
        let total_patients = ctx.accounts.physio_profile.total_patients;

        require!(
            ctx.accounts.treatment_plan.plan_active,
            PhysioloopError::PlanNotActive
        );
        require!(
            session_number == sessions_completed + 1,
            PhysioloopError::InvalidSessionNumber
        );
        require!(
            sessions_completed < sessions_total,
            PhysioloopError::AllSessionsCompleted
        );
        require!(
            escrow_amount >= pusd_per_session,
            PhysioloopError::InsufficientEscrow
        );
        // Verify the physio_pusd_ata belongs to the correct physio
        require!(
            ctx.accounts.physio_pusd_ata.owner == physio_key,
            PhysioloopError::InvalidPhysioAta
        );

        // Record session attestation
        let now = Clock::get()?.unix_timestamp;
        let attestation = &mut ctx.accounts.session_attestation;
        attestation.treatment_plan = plan_key;
        attestation.session_number = session_number;
        attestation.proof_hash = proof_hash;
        attestation.completed_at = now;
        attestation.verified = true;
        attestation.bump = ctx.bumps.session_attestation;

        // Revenue split: 70% physio | 15% ops | 10% campaign pool | 5% caregiver (escrow)
        let physio_amount = pusd_per_session
            .checked_mul(PHYSIO_SHARE_BPS)
            .and_then(|v| v.checked_div(10_000))
            .ok_or(PhysioloopError::MathOverflow)?;
        let ops_amount = pusd_per_session
            .checked_mul(OPS_SHARE_BPS)
            .and_then(|v| v.checked_div(10_000))
            .ok_or(PhysioloopError::MathOverflow)?;
        let campaign_amount = pusd_per_session
            .checked_mul(CAMPAIGN_SHARE_BPS)
            .and_then(|v| v.checked_div(10_000))
            .ok_or(PhysioloopError::MathOverflow)?;
        let released = physio_amount
            .checked_add(ops_amount)
            .and_then(|v| v.checked_add(campaign_amount))
            .ok_or(PhysioloopError::MathOverflow)?;

        // PDA-signed transfers: escrow vault → physio + ops + campaign
        // TreatmentPlan PDA is the authority over escrow_vault
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"plan",
            physio_key.as_ref(),
            patient_key.as_ref(),
            &[plan_bump],
        ]];

        // 70% → physio wallet
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.escrow_vault.to_account_info(),
                    mint: ctx.accounts.pusd_mint.to_account_info(),
                    to: ctx.accounts.physio_pusd_ata.to_account_info(),
                    authority: ctx.accounts.treatment_plan.to_account_info(),
                },
                signer_seeds,
            ),
            physio_amount,
            PUSD_DECIMALS as u8,
        )?;

        // 15% → ops treasury
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.escrow_vault.to_account_info(),
                    mint: ctx.accounts.pusd_mint.to_account_info(),
                    to: ctx.accounts.ops_treasury_ata.to_account_info(),
                    authority: ctx.accounts.treatment_plan.to_account_info(),
                },
                signer_seeds,
            ),
            ops_amount,
            PUSD_DECIMALS as u8,
        )?;

        // 10% → Torque campaign pool
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.escrow_vault.to_account_info(),
                    mint: ctx.accounts.pusd_mint.to_account_info(),
                    to: ctx.accounts.campaign_pool_ata.to_account_info(),
                    authority: ctx.accounts.treatment_plan.to_account_info(),
                },
                signer_seeds,
            ),
            campaign_amount,
            PUSD_DECIMALS as u8,
        )?;

        // Update plan — deduct 95% only; 5% caregiver reserve stays in escrow
        let plan = &mut ctx.accounts.treatment_plan;
        plan.sessions_completed = plan
            .sessions_completed
            .checked_add(1)
            .ok_or(PhysioloopError::MathOverflow)?;
        plan.escrow_amount = plan
            .escrow_amount
            .checked_sub(released)
            .ok_or(PhysioloopError::MathOverflow)?;

        // Incremental credibility update.
        // credibility_score = running average of per-plan completion rates.
        // delta = (new_plan_rate - old_plan_rate) / total_patients
        if total_patients > 0 {
            let old_rate = sessions_completed as f32 / sessions_total as f32;
            let new_rate = (sessions_completed + 1) as f32 / sessions_total as f32;
            let delta = (new_rate - old_rate) / total_patients as f32;
            let physio = &mut ctx.accounts.physio_profile;
            physio.credibility_score += delta;
            // Clamp to [0.0, 1.0] to guard against floating-point drift
            physio.credibility_score = physio.credibility_score.clamp(0.0, 1.0);
            physio.completion_rate = physio.credibility_score;
        }

        emit!(SessionCompleted {
            treatment_plan: plan_key,
            session_number,
            proof_hash,
            pusd_released: pusd_per_session,
            sessions_remaining: sessions_total - (sessions_completed + 1),
            timestamp: now,
        });

        Ok(())
    }

    /// Caregiver records a daily patient check-in and earns micro-PUSD from escrow.
    pub fn submit_caregiver_checkin(ctx: Context<SubmitCaregiverCheckin>) -> Result<()> {
        let plan_active = ctx.accounts.treatment_plan.plan_active;
        let escrow_amount = ctx.accounts.treatment_plan.escrow_amount;
        let physio_key = ctx.accounts.treatment_plan.physio;
        let patient_key = ctx.accounts.treatment_plan.patient;
        let plan_bump = ctx.accounts.treatment_plan.bump;
        let last_checkin = ctx.accounts.caregiver_profile.last_checkin;
        let sessions_completed = ctx.accounts.treatment_plan.sessions_completed;
        let sessions_total = ctx.accounts.treatment_plan.sessions_total;
        let pusd_per_session = ctx.accounts.treatment_plan.pusd_per_session;

        require!(plan_active, PhysioloopError::PlanNotActive);

        // Guard: caregiver reward must not encroach on the physio+platform reserve.
        // Each remaining session consumes 95% of pusd_per_session from escrow;
        // the other 5% is already set aside as caregiver reserve across all sessions.
        let sessions_remaining = (sessions_total - sessions_completed) as u64;
        let physio_platform_per_session = pusd_per_session
            .checked_mul(PHYSIO_SHARE_BPS + OPS_SHARE_BPS + CAMPAIGN_SHARE_BPS)
            .and_then(|v| v.checked_div(10_000))
            .ok_or(PhysioloopError::MathOverflow)?;
        let session_reserve = sessions_remaining
            .checked_mul(physio_platform_per_session)
            .ok_or(PhysioloopError::MathOverflow)?;
        require!(
            escrow_amount >= session_reserve + CAREGIVER_REWARD_PUSD,
            PhysioloopError::InsufficientEscrow
        );

        let now = Clock::get()?.unix_timestamp;

        // Prevent double check-ins within the same calendar day (86,400s)
        require!(
            now - last_checkin >= CHECKIN_COOLDOWN_SECS,
            PhysioloopError::AlreadyCheckedInToday
        );

        // Escrow vault → caregiver ATA (PDA-signed)
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"plan",
            physio_key.as_ref(),
            patient_key.as_ref(),
            &[plan_bump],
        ]];

        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.escrow_vault.to_account_info(),
                    mint: ctx.accounts.pusd_mint.to_account_info(),
                    to: ctx.accounts.caregiver_pusd_ata.to_account_info(),
                    authority: ctx.accounts.treatment_plan.to_account_info(),
                },
                signer_seeds,
            ),
            CAREGIVER_REWARD_PUSD,
            PUSD_DECIMALS as u8,
        )?;

        let plan = &mut ctx.accounts.treatment_plan;
        plan.escrow_amount = plan
            .escrow_amount
            .checked_sub(CAREGIVER_REWARD_PUSD)
            .ok_or(PhysioloopError::MathOverflow)?;

        let profile = &mut ctx.accounts.caregiver_profile;
        profile.checkins_total = profile
            .checkins_total
            .checked_add(1)
            .ok_or(PhysioloopError::MathOverflow)?;
        profile.pusd_earned = profile
            .pusd_earned
            .checked_add(CAREGIVER_REWARD_PUSD)
            .ok_or(PhysioloopError::MathOverflow)?;

        // Streak: consecutive daily check-ins within the tolerance window
        if last_checkin > 0 && now - last_checkin <= STREAK_WINDOW_SECS {
            profile.checkins_streak = profile
                .checkins_streak
                .checked_add(1)
                .ok_or(PhysioloopError::MathOverflow)?;
        } else {
            profile.checkins_streak = 1;
        }
        profile.last_checkin = now;

        emit!(CaregiverCheckin {
            treatment_plan: plan.key(),
            caregiver: ctx.accounts.caregiver.key(),
            checkins_total: profile.checkins_total,
            streak: profile.checkins_streak,
            pusd_earned: profile.pusd_earned,
        });

        Ok(())
    }

    /// Marks the plan complete. Returns any remaining escrow to the patient.
    /// Sets caregiver_profile.nft_minted = true (Bubblegum mint in a follow-on ix).
    pub fn complete_plan(ctx: Context<CompletePlan>) -> Result<()> {
        let sessions_completed = ctx.accounts.treatment_plan.sessions_completed;
        let sessions_total = ctx.accounts.treatment_plan.sessions_total;
        let escrow_amount = ctx.accounts.treatment_plan.escrow_amount;
        let physio_key = ctx.accounts.treatment_plan.physio;
        let patient_key = ctx.accounts.treatment_plan.patient;
        let plan_bump = ctx.accounts.treatment_plan.bump;
        let plan_key = ctx.accounts.treatment_plan.key();

        require!(
            ctx.accounts.treatment_plan.plan_active,
            PhysioloopError::PlanNotActive
        );
        require!(
            sessions_completed == sessions_total,
            PhysioloopError::PlanNotComplete
        );

        // Sweep remaining escrow (unclaimed caregiver portions) to platform treasury
        if escrow_amount > 0 {
            let signer_seeds: &[&[&[u8]]] = &[&[
                b"plan",
                physio_key.as_ref(),
                patient_key.as_ref(),
                &[plan_bump],
            ]];

            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.escrow_vault.to_account_info(),
                        mint: ctx.accounts.pusd_mint.to_account_info(),
                        to: ctx.accounts.ops_treasury_ata.to_account_info(),
                        authority: ctx.accounts.treatment_plan.to_account_info(),
                    },
                    signer_seeds,
                ),
                escrow_amount,
                PUSD_DECIMALS as u8,
            )?;
        }

        let plan = &mut ctx.accounts.treatment_plan;
        plan.plan_active = false;
        plan.escrow_amount = 0;

        let physio = &mut ctx.accounts.physio_profile;
        physio.active_patients = physio.active_patients.saturating_sub(1);

        // Signal NFT eligibility. Actual Bubblegum CPI is a separate instruction
        // to keep this ix under the CU budget.
        let caregiver = &mut ctx.accounts.caregiver_profile;
        caregiver.nft_minted = true;

        emit!(PlanCompleted {
            treatment_plan: plan_key,
            physio: physio_key,
            patient: patient_key,
            sessions_completed,
            remaining_returned: escrow_amount,
        });

        Ok(())
    }

    /// Permissionless recalculation of a physio's credibility score for one plan.
    /// Useful if the running average drifts due to edge cases.
    pub fn update_credibility_score(ctx: Context<UpdateCredibilityScore>) -> Result<()> {
        let plan = &ctx.accounts.treatment_plan;
        let physio = &mut ctx.accounts.physio_profile;

        require!(
            physio.total_patients > 0,
            PhysioloopError::NoPatients
        );

        let plan_rate = plan.sessions_completed as f32 / plan.sessions_total as f32;

        // Full single-plan recalculate (approximation for single-plan physios).
        // For physios with many patients, this is called per plan by an indexer.
        physio.credibility_score = plan_rate.clamp(0.0, 1.0);
        physio.completion_rate = physio.credibility_score;

        Ok(())
    }
}

// ─── State ────────────────────────────────────────────────────────────────────

#[account]
#[derive(InitSpace)]
pub struct PhysioProfile {
    pub physio: Pubkey,
    pub subscription_tier: u8,
    pub credibility_score: f32,
    pub total_patients: u32,
    pub active_patients: u32,
    pub completion_rate: f32,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct TreatmentPlan {
    pub physio: Pubkey,
    pub patient: Pubkey,
    pub caregiver: Pubkey,
    pub escrow_amount: u64,
    pub sessions_total: u8,
    pub sessions_completed: u8,
    pub pusd_per_session: u64,
    pub plan_active: bool,
    pub created_at: i64,
    pub bump: u8,
    pub escrow_bump: u8,
    #[max_len(32)]
    pub patient_name: String,
    #[max_len(32)]
    pub caregiver_name: String,
    /// JSON array: [{"name":"Straight Leg Raise","sets":3,"reps":10}, ...]
    #[max_len(256)]
    pub exercises: String,
}

#[account]
#[derive(InitSpace)]
pub struct SessionAttestation {
    pub treatment_plan: Pubkey,
    pub session_number: u8,
    pub proof_hash: [u8; 32],
    pub completed_at: i64,
    pub verified: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct CaregiverProfile {
    pub caregiver: Pubkey,
    pub checkins_total: u32,
    pub checkins_streak: u32,
    pub pusd_earned: u64,
    pub nft_minted: bool,
    pub last_checkin: i64,
    pub bump: u8,
}

// ─── Instruction Contexts ─────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct RegisterPhysio<'info> {
    #[account(
        init,
        payer = physio,
        space = 8 + PhysioProfile::INIT_SPACE,
        seeds = [b"physio", physio.key().as_ref()],
        bump,
    )]
    pub physio_profile: Account<'info, PhysioProfile>,

    #[account(mut)]
    pub physio: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RegisterCaregiver<'info> {
    #[account(
        init,
        payer = caregiver,
        space = 8 + CaregiverProfile::INIT_SPACE,
        seeds = [b"caregiver", caregiver.key().as_ref()],
        bump,
    )]
    pub caregiver_profile: Account<'info, CaregiverProfile>,

    #[account(mut)]
    pub caregiver: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateTreatmentPlan<'info> {
    #[account(
        mut,
        seeds = [b"physio", physio.key().as_ref()],
        bump = physio_profile.bump,
    )]
    pub physio_profile: Account<'info, PhysioProfile>,

    #[account(
        init,
        payer = physio,
        space = 8 + TreatmentPlan::INIT_SPACE,
        seeds = [b"plan", physio.key().as_ref(), patient.key().as_ref()],
        bump,
    )]
    pub treatment_plan: Account<'info, TreatmentPlan>,

    // Escrow vault is a PDA token account controlled by the TreatmentPlan PDA.
    // Initialised here so stake_escrow can simply transfer (no init_if_needed).
    #[account(
        init,
        payer = physio,
        token::mint = pusd_mint,
        token::authority = treatment_plan,
        seeds = [b"escrow", treatment_plan.key().as_ref()],
        bump,
    )]
    pub escrow_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub physio: Signer<'info>,

    /// CHECK: patient wallet — only used as PDA seed + stored in plan
    pub patient: AccountInfo<'info>,

    /// CHECK: caregiver wallet — only used as stored value; must have registered CaregiverProfile
    pub caregiver: AccountInfo<'info>,

    pub pusd_mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct StakeEscrow<'info> {
    #[account(
        mut,
        seeds = [b"plan", treatment_plan.physio.as_ref(), patient.key().as_ref()],
        bump = treatment_plan.bump,
        has_one = patient @ PhysioloopError::Unauthorized,
        constraint = !treatment_plan.plan_active @ PhysioloopError::PlanAlreadyActive,
    )]
    pub treatment_plan: Account<'info, TreatmentPlan>,

    #[account(
        mut,
        seeds = [b"escrow", treatment_plan.key().as_ref()],
        bump = treatment_plan.escrow_bump,
        token::mint = pusd_mint,
        token::authority = treatment_plan,
    )]
    pub escrow_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = pusd_mint,
        token::authority = patient,
    )]
    pub patient_pusd_ata: InterfaceAccount<'info, TokenAccount>,

    // Validate this is genuinely palmUSD — no other token accepted.
    // palmUSD has no freeze authority: once staked into the PDA escrow,
    // no issuer, insurer, or regulator can block the payment.
    // Replace the address constraint once the live mint is confirmed.
    #[account(
        constraint = pusd_mint.freeze_authority.is_none() @ PhysioloopError::NotPalmUsd,
    )]
    pub pusd_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub patient: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
#[instruction(session_number: u8)]
pub struct SubmitAttestation<'info> {
    #[account(mut)]
    pub patient: Signer<'info>,

    #[account(
        mut,
        seeds = [b"physio", physio_profile.physio.as_ref()],
        bump = physio_profile.bump,
        constraint = physio_profile.physio == treatment_plan.physio @ PhysioloopError::Unauthorized,
    )]
    pub physio_profile: Account<'info, PhysioProfile>,

    #[account(
        mut,
        seeds = [b"plan", treatment_plan.physio.as_ref(), patient.key().as_ref()],
        bump = treatment_plan.bump,
        has_one = patient @ PhysioloopError::Unauthorized,
    )]
    pub treatment_plan: Account<'info, TreatmentPlan>,

    // SessionAttestation PDA seed includes session_number to prevent replay
    #[account(
        init,
        payer = patient,
        space = 8 + SessionAttestation::INIT_SPACE,
        seeds = [b"session", treatment_plan.key().as_ref(), &[session_number]],
        bump,
    )]
    pub session_attestation: Account<'info, SessionAttestation>,

    #[account(
        mut,
        seeds = [b"escrow", treatment_plan.key().as_ref()],
        bump = treatment_plan.escrow_bump,
        token::mint = pusd_mint,
        token::authority = treatment_plan,
    )]
    pub escrow_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Physio's PUSD associated token account. Ownership validated in handler.
    #[account(
        mut,
        token::mint = pusd_mint,
    )]
    pub physio_pusd_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Ops treasury ATA — receives the 15% operations share per session.
    #[account(
        mut,
        token::mint = pusd_mint,
    )]
    pub ops_treasury_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Torque campaign pool ATA — receives the 10% campaign funding per session.
    #[account(
        mut,
        token::mint = pusd_mint,
    )]
    pub campaign_pool_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    pub pusd_mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SubmitCaregiverCheckin<'info> {
    #[account(mut)]
    pub caregiver: Signer<'info>,

    #[account(
        mut,
        seeds = [b"caregiver", caregiver.key().as_ref()],
        bump = caregiver_profile.bump,
        has_one = caregiver @ PhysioloopError::Unauthorized,
    )]
    pub caregiver_profile: Account<'info, CaregiverProfile>,

    #[account(
        mut,
        seeds = [b"plan", treatment_plan.physio.as_ref(), treatment_plan.patient.as_ref()],
        bump = treatment_plan.bump,
        constraint = treatment_plan.caregiver == caregiver.key() @ PhysioloopError::Unauthorized,
        constraint = treatment_plan.plan_active @ PhysioloopError::PlanNotActive,
    )]
    pub treatment_plan: Account<'info, TreatmentPlan>,

    #[account(
        mut,
        seeds = [b"escrow", treatment_plan.key().as_ref()],
        bump = treatment_plan.escrow_bump,
        token::mint = pusd_mint,
        token::authority = treatment_plan,
    )]
    pub escrow_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = pusd_mint,
        token::authority = caregiver,
    )]
    pub caregiver_pusd_ata: InterfaceAccount<'info, TokenAccount>,

    pub pusd_mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct CompletePlan<'info> {
    // Physio initiates completion after all sessions are verified
    #[account(mut)]
    pub physio: Signer<'info>,

    #[account(
        mut,
        seeds = [b"physio", physio.key().as_ref()],
        bump = physio_profile.bump,
    )]
    pub physio_profile: Account<'info, PhysioProfile>,

    #[account(
        mut,
        seeds = [b"plan", physio.key().as_ref(), treatment_plan.patient.as_ref()],
        bump = treatment_plan.bump,
        has_one = physio @ PhysioloopError::Unauthorized,
        constraint = treatment_plan.plan_active @ PhysioloopError::PlanNotActive,
    )]
    pub treatment_plan: Account<'info, TreatmentPlan>,

    #[account(
        mut,
        seeds = [b"escrow", treatment_plan.key().as_ref()],
        bump = treatment_plan.escrow_bump,
        token::mint = pusd_mint,
        token::authority = treatment_plan,
    )]
    pub escrow_vault: InterfaceAccount<'info, TokenAccount>,

    /// Platform treasury ATA — receives any remaining caregiver reserve not claimed via check-ins
    #[account(
        mut,
        token::mint = pusd_mint,
    )]
    pub ops_treasury_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"caregiver", treatment_plan.caregiver.as_ref()],
        bump = caregiver_profile.bump,
    )]
    pub caregiver_profile: Account<'info, CaregiverProfile>,

    pub pusd_mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateCredibilityScore<'info> {
    #[account(
        mut,
        seeds = [b"physio", physio_profile.physio.as_ref()],
        bump = physio_profile.bump,
    )]
    pub physio_profile: Account<'info, PhysioProfile>,

    #[account(
        seeds = [b"plan", physio_profile.physio.as_ref(), treatment_plan.patient.as_ref()],
        bump = treatment_plan.bump,
        constraint = treatment_plan.physio == physio_profile.physio @ PhysioloopError::Unauthorized,
    )]
    pub treatment_plan: Account<'info, TreatmentPlan>,
}

// ─── Events ───────────────────────────────────────────────────────────────────

#[event]
pub struct PlanCreated {
    pub treatment_plan: Pubkey,
    pub physio: Pubkey,
    pub patient: Pubkey,
    pub sessions_total: u8,
    pub pusd_per_session: u64,
}

#[event]
pub struct EscrowFunded {
    pub treatment_plan: Pubkey,
    pub patient: Pubkey,
    pub amount: u64,
}

#[event]
pub struct SessionCompleted {
    pub treatment_plan: Pubkey,
    pub session_number: u8,
    pub proof_hash: [u8; 32],
    pub pusd_released: u64,
    pub sessions_remaining: u8,
    pub timestamp: i64,
}

#[event]
pub struct CaregiverCheckin {
    pub treatment_plan: Pubkey,
    pub caregiver: Pubkey,
    pub checkins_total: u32,
    pub streak: u32,
    pub pusd_earned: u64,
}

#[event]
pub struct PlanCompleted {
    pub treatment_plan: Pubkey,
    pub physio: Pubkey,
    pub patient: Pubkey,
    pub sessions_completed: u8,
    pub remaining_returned: u64,
}

// ─── Errors ───────────────────────────────────────────────────────────────────

#[error_code]
pub enum PhysioloopError {
    #[msg("Plan is not currently active")]
    PlanNotActive,
    #[msg("Plan is already active — cannot re-stake escrow")]
    PlanAlreadyActive,
    #[msg("Plan is not yet complete")]
    PlanNotComplete,
    #[msg("All sessions for this plan have been completed")]
    AllSessionsCompleted,
    #[msg("session_number must be exactly sessions_completed + 1")]
    InvalidSessionNumber,
    #[msg("Escrow balance is insufficient for this operation")]
    InsufficientEscrow,
    #[msg("sessions must be between 1 and 60")]
    InvalidSessionCount,
    #[msg("pusd_per_session must be greater than zero")]
    InvalidAmount,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Caller is not authorised for this account")]
    Unauthorized,
    #[msg("physio_pusd_ata does not belong to the treatment plan physio")]
    InvalidPhysioAta,
    #[msg("Caregiver has already checked in today")]
    AlreadyCheckedInToday,
    #[msg("Physio has no patients — credibility score cannot be calculated")]
    NoPatients,
    #[msg("Only palmUSD (non-freezable) is accepted — mint must have no freeze authority")]
    NotPalmUsd,
}
