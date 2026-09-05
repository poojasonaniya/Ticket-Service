import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { TicketsService } from './tickets.service';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { ListTicketsQueryDto } from './dto/list-tickets-query.dto';

@Controller('tickets')
export class TicketsController {
  constructor(private readonly ticketsService: TicketsService) {}

  @Post()
  async create(
    @Body() dto: CreateTicketDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { ticket, created } = await this.ticketsService.create(dto);
    res.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return ticket;
  }

  @Get()
  async findMany(@Query() query: ListTicketsQueryDto) {
    return this.ticketsService.findMany(query);
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.ticketsService.findOne(id);
  }

  @Post(':id/reclassify')
  async reclassify(@Param('id') id: string) {
    return this.ticketsService.reclassify(id);
  }
}
